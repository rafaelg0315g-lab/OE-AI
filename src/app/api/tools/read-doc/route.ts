import { z } from 'zod'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_PDF_BYTES = 15 * 1024 * 1024 // 15 MB tras decodificar el data URL
const MAX_TEXT_CHARS = 24_000
const TRIM_NOTE = '[...contenido recortado...]'
const MAX_PDF_PAGES_PARSED = 60 // cota de rendimiento: el texto se recorta antes igualmente

const ReadDocBodySchema = z
  .object({
    url: z.string().url().max(2000).optional(),
    fileDataUrl: z
      .string()
      .regex(/^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/, 'Data URL de PDF inválido.')
      .optional(),
    name: z.string().max(200).optional(),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.fileDataUrl), {
    message: 'Envía exactamente una fuente: url (web) o fileDataUrl (PDF), no ambas.',
  })

/** Convierte el HTML de una página a texto plano legible. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // los saltos de bloque se convierten en separadores antes de quitar etiquetas
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function trimText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)} ${TRIM_NOTE}`
}

/** Decodifica un data URL "data:application/pdf;base64,…". */
function pdfBufferFromDataUrl(dataUrl: string): Buffer {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return Buffer.from(payload, 'base64')
}

/**
 * POST /api/tools/read-doc — lectura de documentos para el chat:
 * un enlace web (page_reader del núcleo) o un PDF adjunto (data URL).
 * Devuelve texto plano recortado a 24.000 caracteres. No consume cuota.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'tools-read-doc'), 10, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de lecturas de documentos por minuto alcanzado. Espera unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  let body: z.infer<typeof ReadDocBodySchema>
  try {
    body = ReadDocBodySchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: 'Payload inválido: envía url (enlace web) o fileDataUrl (PDF en base64, máx. 15 MB), pero no ambos.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  const startedAt = Date.now()

  // ── PDF adjunto ───────────────────────────────────────────────────────────
  if (body.fileDataUrl) {
    const buffer = pdfBufferFromDataUrl(body.fileDataUrl)
    if (!buffer.byteLength || buffer.byteLength > MAX_PDF_BYTES) {
      return Response.json(
        { error: 'El PDF es demasiado grande o está vacío (máx. 15 MB tras decodificar).', requestId },
        { status: 413, headers: { 'X-Request-Id': requestId } },
      )
    }
    let parser: {
      getText(args: { pageJoiner: string }): Promise<{ text: string; total: number }>
      destroy(): Promise<void>
    } | null = null
    try {
      const { PDFParse } = await import('pdf-parse')
      parser = new PDFParse({ data: new Uint8Array(buffer) })
      const result = await parser.getText({ pageJoiner: '' })
      const text = trimText(result.text.replace(/\s+/g, ' ').trim())
      if (!text) throw new Error('El PDF no contiene texto extraíble (puede ser un escaneo de imágenes).')
      await recordUsage({
        requestId,
        source: 'tool_read_doc',
        providerId: 'oe-local',
        requestedModelId: 'pdf-parse',
        resolvedModelId: 'pdf-parse',
        status: 'ok',
        latencyMs: Date.now() - startedAt,
        completionChars: text.length,
      })
      return Response.json(
        {
          title: body.name?.trim() || 'Documento PDF',
          text,
          pages: result.total,
          source: 'pdf',
          latencyMs: Date.now() - startedAt,
          requestId,
        },
        { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
      )
    } catch (err) {
      await recordUsage({
        requestId,
        source: 'tool_read_doc',
        providerId: 'oe-local',
        requestedModelId: 'pdf-parse',
        status: 'error',
        errorType: 'read_doc_pdf_error',
        latencyMs: Date.now() - startedAt,
      })
      const message = err instanceof Error ? err.message : 'No se pudo leer el PDF.'
      return Response.json(
        { error: `No se pudo leer el PDF: ${message}`, requestId },
        { status: 422, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
      )
    } finally {
      try {
        await parser?.destroy()
      } catch {
        // el destructor del parser nunca debe romper la respuesta
      }
    }
  }

  // ── Enlace web ────────────────────────────────────────────────────────────
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    const result = await zai.functions.invoke('page_reader', { url: body.url! })
    const data = (result as { data?: { title?: string; html?: string } })?.data
    const html = data?.html ?? ''
    if (!html) throw new Error('La página no devolvió contenido legible.')
    const text = trimText(htmlToPlainText(html))
    await recordUsage({
      requestId,
      source: 'tool_read_doc',
      providerId: 'zai-org',
      requestedModelId: 'page_reader',
      resolvedModelId: 'page_reader',
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      completionChars: text.length,
    })
    return Response.json(
      {
        title: data?.title?.trim() || body.url!,
        text,
        source: 'web',
        latencyMs: Date.now() - startedAt,
        requestId,
      },
      { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
    )
  } catch (err) {
    console.error('[api/tools/read-doc] error:', err instanceof Error ? err.message.slice(0, 200) : err)
    await recordUsage({
      requestId,
      source: 'tool_read_doc',
      providerId: 'zai-org',
      requestedModelId: 'page_reader',
      status: 'error',
      errorType: 'read_doc_web_error',
      latencyMs: Date.now() - startedAt,
    })
    const message = err instanceof Error ? err.message : 'No se pudo leer el enlace.'
    return Response.json(
      { error: message, requestId },
      { status: 502, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
    )
  }
}
