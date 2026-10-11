import { z } from 'zod'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'
import { geminiTranscribeAudio } from '@/lib/ai/gemini-direct'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_AUDIO_BYTES = 10 * 1024 * 1024 // 10 MB tras decodificar

const AsrBodySchema = z.object({
  // Nota de voz grabada en el navegador (MediaRecorder): webm/opus, wav o mp4.
  // El ASR del núcleo solo acepta WAV y WebM: otros formatos devuelven un
  // error honesto del proveedor.
  audio: z
    .string()
    .regex(/^data:audio\/(webm|wav|x-wav|mp4);base64,[A-Za-z0-9+/=]+$/, 'Data URL de audio inválido.'),
  language: z.string().max(20).optional(),
})

/**
 * POST /api/tools/asr — transcripción de nota de voz (solo servidor).
 * Recibe un data URL de audio, extrae SOLO el base64 (sin el prefijo data:)
 * y lo envía al ASR del núcleo. No consume cuota de invitado (transcribir es
 * gratis; el turno lo consume el mensaje que se envíe después).
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'tools-asr'), 15, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de transcripciones por minuto alcanzado. Espera unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  let body: z.infer<typeof AsrBodySchema>
  try {
    body = AsrBodySchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: 'Audio inválido. Formatos permitidos: audio/webm, audio/wav o audio/mp4 (máx. 10 MB).', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  // file_base64 = SOLO el base64, sin el prefijo "data:audio/…;base64,".
  const fileBase64 = body.audio.slice(body.audio.indexOf(',') + 1)
  const approxBytes = Math.floor((fileBase64.length * 3) / 4)
  if (!approxBytes || approxBytes > MAX_AUDIO_BYTES) {
    return Response.json(
      { error: 'El audio es demasiado grande o está vacío (máx. 10 MB tras decodificar).', requestId },
      { status: 413, headers: { 'X-Request-Id': requestId } },
    )
  }

  const startedAt = Date.now()
  // CASCADA de transcripción: núcleo z-ai (sandbox) → Gemini directo (audio
  // inline, multimodal). En Vercel el SDK del sandbox no tiene credenciales:
  // el respaldo mantiene la entrada por voz operativa.
  let text = ''
  let usedProvider = 'zai-org'
  try {
    try {
      const { default: ZAI } = await import('z-ai-web-dev-sdk')
      const zai = await ZAI.create()
      const result = (await zai.audio.asr.create({
        file_base64: fileBase64,
        ...(body.language ? { language: body.language } : {}),
      })) as { text?: string }
      text = (result?.text ?? '').trim()
    } catch (zaiErr) {
      console.warn('[api/tools/asr] núcleo no disponible; probando respaldo Gemini:', zaiErr instanceof Error ? zaiErr.message.slice(0, 120) : zaiErr)
    }
    if (!text && process.env.GEMINI_API_KEY?.trim()) {
      const mimeMatch = /^data:([^;,]+);base64,/.exec(body.audio)
      text = await geminiTranscribeAudio(fileBase64, mimeMatch?.[1] ?? 'audio/webm', body.language)
      usedProvider = 'gemini-direct'
    }
    if (!text) {
      throw new Error('No se reconoció ninguna voz en el audio.')
    }

    await recordUsage({
      requestId,
      source: 'tool_asr',
      providerId: usedProvider,
      requestedModelId: 'asr',
      resolvedModelId: 'asr',
      status: 'ok',
      latencyMs: Date.now() - startedAt,
    })

    return Response.json(
      { text, latencyMs: Date.now() - startedAt, requestId },
      { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
    )
  } catch (err) {
    console.error('[api/tools/asr] error:', err instanceof Error ? err.message.slice(0, 200) : err)
    await recordUsage({
      requestId,
      source: 'tool_asr',
      providerId: 'cascade',
      requestedModelId: 'asr',
      status: 'error',
      errorType: 'asr_error',
      latencyMs: Date.now() - startedAt,
    })
    const message = err instanceof Error ? err.message : 'No se pudo transcribir el audio.'
    return Response.json(
      { error: message, requestId },
      { status: 502, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
    )
  }
}
