import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'
import { consumeGuestChat, guestCookieHeader, resolveChatIdentity } from '@/lib/auth/guest'
import { geminiImageEdit, sniffImageMime } from '@/lib/ai/gemini-direct'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Tamaños soportados realmente por el proveedor de imágenes. */
const SUPPORTED_SIZES = ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'] as const

const MAX_IMAGE_BYTES = 6 * 1024 * 1024 // 6 MB tras decodificar

// Nota: sniffImageMime vive en '@/lib/ai/gemini-direct' (magic bytes). NO redefinir aquí: rompe `next build`.

const ImageEditBodySchema = z.object({
  // Data URL de la imagen a editar (PNG/JPEG/WebP, ≤6 MB decodificados).
  image: z.string().regex(/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/, 'Data URL de imagen inválido.'),
  prompt: z.string().min(1).max(600),
  size: z.enum(SUPPORTED_SIZES).optional().default('1024x1024'),
})

/**
 * POST /api/tools/image-edit — edición de imagen IA (solo servidor):
 * recibe una imagen (data URL) y una instrucción, la reenvía al proveedor de
 * edición y persiste el resultado en GeneratedAsset (image/png).
 * Consume un turno de la cuota de invitado (misma compuerta que la generación).
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  // Límite propio para la herramienta de edición de imágenes.
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'tools-image-edit'), 6, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de ediciones de imagen alcanzado. Espera un momento e inténtalo de nuevo.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  let body: z.infer<typeof ImageEditBodySchema>
  try {
    body = ImageEditBodySchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: 'Payload inválido: imagen (data URL PNG/JPEG/WebP, máx. 6 MB) y prompt (1-600 caracteres) son obligatorios.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  const prompt = body.prompt.trim()

  // Valida el tamaño REAL decodificando el base64 (un data URL de 6 MB puede
  // declarar cualquier cosa: la autoridad es el servidor).
  const [, payload] = body.image.split(',')
  const imageBuffer = Buffer.from(payload ?? '', 'base64')
  if (!imageBuffer.byteLength || imageBuffer.byteLength > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: 'La imagen es demasiado grande o está vacía (máx. 6 MB tras decodificar).', requestId },
      { status: 413, headers: { 'X-Request-Id': requestId } },
    )
  }

  // Identidad + cuota: editar una imagen es un turno de chat para invitados.
  let guestSetCookie: string | null = null
  try {
    const identity = await resolveChatIdentity(request)
    if (identity.kind === 'guest') {
      const quota = await consumeGuestChat(identity.guestId)
      if (!quota.allowed) {
        return Response.json(
          {
            error: `Has usado tus ${quota.limit} usos gratis de esta sesión. Inicia sesión con Google o GitHub para seguir editando imágenes y conversando sin límite.`,
            errorType: 'guest_limit_reached',
            used: quota.used,
            limit: quota.limit,
            requestId,
          },
          {
            status: 403,
            headers: {
              'X-Request-Id': requestId,
              ...(identity.isNewGuest ? { 'Set-Cookie': guestCookieHeader(identity.guestId) } : {}),
            },
          },
        )
      }
      if (identity.isNewGuest) guestSetCookie = guestCookieHeader(identity.guestId)
    }
  } catch (quotaErr) {
    console.error('[api/tools/image-edit] cuota de invitado no disponible:', quotaErr instanceof Error ? quotaErr.message : quotaErr)
  }

  const startedAt = Date.now()

  // CASCADA de edición (política de despliegue): núcleo z-ai (sandbox) →
  // Gemini directo (imagen entrada + instrucción) → OpenRouter (modelo con
  // salida de imagen recibiendo la imagen de entrada). Pollinations NO entra:
  // no soporta edición con imagen de referencia.
  type EditOutcome = { buffer: Buffer; mime: string; providerId: string; reportedModel: string }
  const OR_EDIT_MODELS = ['google/gemini-2.5-flash-image', 'google/gemini-3.1-flash-image', 'openai/gpt-5-image-mini']

  const editors: Array<{ id: string; run: () => Promise<EditOutcome> }> = [
    {
      id: 'zai-org',
      run: async () => {
        const { default: ZAI } = await import('z-ai-web-dev-sdk')
        const zai = await ZAI.create()
        // El SDK reenvía el cuerpo tal cual a /images/generations/edit: la imagen
        // viaja como data URL en `images[0].url`.
        const result = await zai.images.generations.edit({
          prompt,
          images: [{ url: body.image }],
          size: body.size,
        } as unknown as Parameters<typeof zai.images.generations.edit>[0])
        const base64 = result?.data?.[0]?.base64
        if (!base64) {
          throw new Error('El proveedor de edición no devolvió datos utilizables.')
        }
        const buffer = Buffer.from(base64, 'base64')
        return { buffer, mime: sniffImageMime(buffer), providerId: 'zai-org', reportedModel: 'image-edit' }
      },
    },
    {
      id: 'gemini-direct',
      run: async () => {
        const img = await geminiImageEdit(prompt, body.image, body.size)
        return { buffer: img.buffer, mime: sniffImageMime(img.buffer), providerId: 'gemini-direct', reportedModel: img.model }
      },
    },
    {
      id: 'openrouter',
      run: async () => {
        const key = process.env.OPENROUTER_API_KEY?.trim()
        if (!key) throw new Error('OPENROUTER_API_KEY no configurada.')
        let lastErr = 'sin intentos'
        for (const model of OR_EDIT_MODELS) {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              modalities: ['image', 'text'],
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'image_url', image_url: { url: body.image } },
                    { type: 'text', text: prompt.slice(0, 600) },
                  ],
                },
              ],
            }),
            signal: AbortSignal.timeout(120_000),
          })
          const data = (await res.json().catch(() => null)) as {
            error?: { message?: string }
            choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>
          } | null
          const dataUrl = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url
          if (res.ok && dataUrl) {
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
            const buffer = Buffer.from(base64, 'base64')
            if (buffer.byteLength) {
              return { buffer, mime: sniffImageMime(buffer), providerId: 'openrouter', reportedModel: model }
            }
          }
          lastErr = data?.error?.message?.slice(0, 140) || `HTTP ${res.status}`
        }
        throw new Error(`OpenRouter sin edición: ${lastErr}`)
      },
    },
  ]

  try {
    let outcome: EditOutcome | null = null
    let lastError: unknown = null
    for (const editor of editors) {
      try {
        outcome = await editor.run()
        if (editor.id !== 'zai-org') {
          console.warn(`[api/tools/image-edit] editada con respaldo ${editor.id}`)
        }
        break
      } catch (editErr) {
        lastError = editErr
      }
    }
    if (!outcome) throw lastError instanceof Error ? lastError : new Error('Ningún proveedor de edición disponible.')
    const resultMime = outcome.mime

    const asset = await db.generatedAsset.create({
      data: { sessionId: null, prompt, size: body.size, mime: resultMime, data: outcome.buffer },
      select: { id: true },
    })

    await recordUsage({
      requestId,
      source: 'tool_image_edit',
      providerId: outcome.providerId,
      requestedModelId: 'image-edit',
      resolvedModelId: outcome.reportedModel,
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      promptChars: prompt.length,
    })

    return Response.json(
      {
        id: asset.id,
        url: `/api/assets/${asset.id}`,
        mimeType: resultMime,
        prompt,
        size: body.size,
        latencyMs: Date.now() - startedAt,
        requestId,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
          'X-Request-Id': requestId,
          ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}),
        },
      },
    )
  } catch (err) {
    console.error('[api/tools/image-edit] error:', err instanceof Error ? err.message.slice(0, 200) : err)
    await recordUsage({
      requestId,
      source: 'tool_image_edit',
      providerId: 'cascade',
      requestedModelId: 'image-edit',
      status: 'error',
      errorType: 'image_edit_error',
      latencyMs: Date.now() - startedAt,
    })
    const message = err instanceof Error ? err.message : 'No se pudo editar la imagen.'
    return Response.json(
      { error: message, requestId },
      { status: 502, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
    )
  }
}
