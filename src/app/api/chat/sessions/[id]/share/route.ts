import { randomBytes } from 'crypto'
import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { resolveAuthUser } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'

const ParamsSchema = z.object({ id: z.string().uuid() })

/**
 * POST /api/chat/sessions/[id]/share — crea (o reutiliza) el enlace público
 * de lectura de una conversación. El token de 32 hex es la única credencial:
 * quien lo tenga puede leer la conversación vía /api/share/[token].
 * PRIVACIDAD: si el chat tiene propietario, SOLO su dueño puede generar el
 * enlace (compartir es una decisión explícita del propietario, nunca un
 * efecto de conocer el uuid).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = crypto.randomUUID()

  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'share-create'), 10, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de enlaces compartidos por minuto alcanzado. Espera unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  const { id } = await params
  const parsed = ParamsSchema.safeParse({ id })
  if (!parsed.success) {
    return Response.json(
      { error: 'Identificador de conversación inválido.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  try {
    const session = await db.chatSession.findUnique({ where: { id }, select: { id: true, ownerKey: true } })
    if (!session) {
      return Response.json(
        { error: 'La conversación no existe o fue eliminada.', requestId },
        { status: 404, headers: { 'X-Request-Id': requestId } },
      )
    }
    if (session.ownerKey) {
      const caller = await resolveAuthUser(request)
      if (!caller || caller.supabaseId !== session.ownerKey) {
        return Response.json(
          { error: 'Este chat es privado: solo su propietario puede compartirlo.', requestId },
          { status: 404, headers: { 'X-Request-Id': requestId } },
        )
      }
    }

    // Reutiliza el enlace existente: compartir dos veces devuelve el mismo token.
    const existing = await db.shareLink.findFirst({ where: { sessionId: id }, select: { token: true } })
    if (existing) {
      return Response.json(
        { url: `/?share=${existing.token}`, token: existing.token, reused: true, requestId },
        { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
      )
    }

    const token = randomBytes(16).toString('hex')
    await db.shareLink.create({ data: { token, sessionId: id } })
    return Response.json(
      { url: `/?share=${token}`, token, requestId },
      { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
    )
  } catch (err) {
    console.error('[api/chat/sessions/:id/share] error:', err instanceof Error ? err.message : err)
    return Response.json(
      { error: 'No se pudo crear el enlace compartido.', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    )
  }
}
