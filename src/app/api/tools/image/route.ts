import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'
import { consumeGuestChat, guestCookieHeader, resolveChatIdentity } from '@/lib/auth/guest'
import { generateImageWithCascade } from '@/lib/ai/image-cascade'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Tamaños soportados realmente por el proveedor de imágenes. */
const SUPPORTED_SIZES = ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'] as const

const ImageBodySchema = z.object({
  sessionId: z.string().uuid(),
  prompt: z.string().min(3).max(900),
  size: z.enum(SUPPORTED_SIZES).optional().default('1024x1024'),
})

/**
 * POST /api/tools/image — genera una imagen con el proveedor conectado
 * (solo servidor), la persiste como activo y registra el mensaje en la sesión.
 * Devuelve { assetId, url, prompt, size }.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  // Límite propio para la herramienta de imágenes (coste por generación)
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'tools-image'), 6, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de generación de imágenes alcanzado. Espera un momento e inténtalo de nuevo.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  let body: z.infer<typeof ImageBodySchema>
  try {
    body = ImageBodySchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: 'Payload inválido: sessionId (uuid) y prompt (3-900 caracteres) son obligatorios.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  // Asegura la sesión y guarda el mensaje del usuario (el prompt tal cual)
  const prompt = body.prompt.trim()

  // Identidad + cuota: generar una imagen es un turno de chat para invitados
  // (misma cuota de N chats gratis por sesión de navegador).
  let guestSetCookie: string | null = null
  try {
    const identity = await resolveChatIdentity(request)
    if (identity.kind === 'guest') {
      const quota = await consumeGuestChat(identity.guestId)
      if (!quota.allowed) {
        return Response.json(
          {
            error: `Has usado tus ${quota.limit} usos gratis de esta sesión. Inicia sesión con Google o GitHub para seguir generando imágenes y conversando sin límite.`,
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
    console.error('[api/tools/image] cuota de invitado no disponible:', quotaErr instanceof Error ? quotaErr.message : quotaErr)
  }

  await db.chatSession.upsert({
    where: { id: body.sessionId },
    create: { id: body.sessionId, title: `Imagen: ${prompt.slice(0, 52)}` },
    update: { updatedAt: new Date() },
  })
  await db.chatMessage.create({
    data: { sessionId: body.sessionId, role: 'user', content: prompt, requestedModelId: 'tool:image', status: 'ok' },
  })

  const startedAt = Date.now()

  try {
    // CASCADA compartida (política de despliegue): núcleo z-ai (sandbox) →
    // Gemini directo → OpenRouter → Pollinations (gratuita y sin clave).
    // Gana el primero que devuelva una imagen utilizable.
    const outcome = await generateImageWithCascade({ prompt, size: body.size })

    const asset = await db.generatedAsset.create({
      data: { sessionId: body.sessionId, prompt, size: body.size, mime: outcome.mime, data: outcome.buffer },
    })

    const message = await db.chatMessage.create({
      data: {
        sessionId: body.sessionId,
        role: 'assistant',
        content: prompt,
        kind: 'image',
        assetId: asset.id,
        requestedModelId: 'tool:image',
        providerId: outcome.providerId,
        providerReportedModel: outcome.reportedModel,
        status: 'ok',
        latencyMs: Date.now() - startedAt,
      },
    })

    await recordUsage({
      requestId,
      source: 'tool_image',
      providerId: outcome.providerId,
      requestedModelId: 'image-generation',
      resolvedModelId: outcome.reportedModel,
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      promptChars: prompt.length,
    })

    return Response.json(
      {
        assetId: asset.id,
        url: `/api/assets/${asset.id}`,
        messageId: message.id,
        prompt,
        size: body.size,
        providerId: outcome.providerId,
        latencyMs: Date.now() - startedAt,
        requestId,
      },
      { headers: { 'X-Request-Id': requestId, ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}) } },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No se pudo generar la imagen.'
    await recordUsage({
      requestId,
      source: 'tool_image',
      providerId: 'cascade',
      requestedModelId: 'image-generation',
      status: 'error',
      errorType: 'image_generation_error',
      latencyMs: Date.now() - startedAt,
    })
    return Response.json({ error: message, requestId }, { status: 502, headers: { 'X-Request-Id': requestId } })
  }
}
