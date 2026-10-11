import { z } from 'zod'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const MAX_MESSAGES = 200

const ParamsSchema = z.object({ token: z.string().regex(/^[0-9a-f]{32}$/, 'Token de enlace inválido.') })

/**
 * GET /api/share/[token] — datos públicos de una conversación compartida
 * (SIN autenticación: el token aleatorio es la única credencial).
 * Devuelve el título, la fecha y los mensajes legibles (con la URL de la
 * imagen adjunta si la hay). Nunca expone identidad del propietario,
 * proveedores, latencias ni otro metadato de enrutamiento.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const parsed = ParamsSchema.safeParse({ token })
  if (!parsed.success) {
    return Response.json({ error: 'Enlace compartido inválido.' }, { status: 400 })
  }

  try {
    const link = await db.shareLink.findUnique({ where: { token: parsed.data.token }, select: { sessionId: true } })
    if (!link) {
      return Response.json({ error: 'Este enlace compartido no existe o fue revocado.' }, { status: 404 })
    }
    const session = await db.chatSession.findUnique({
      where: { id: link.sessionId },
      select: { id: true, title: true, createdAt: true },
    })
    if (!session) {
      return Response.json({ error: 'La conversación compartida ya no está disponible.' }, { status: 404 })
    }
    const messages = await db.chatMessage.findMany({
      where: { sessionId: session.id, status: 'ok' },
      orderBy: { createdAt: 'asc' },
      take: MAX_MESSAGES,
      select: { role: true, content: true, attachmentAssetId: true, assetId: true },
    })
    return Response.json(
      {
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          // Imagen adjuntada por el usuario o imagen generada (mismo patrón
          // que /api/chat/history para restaurar la conversación).
          ...(m.attachmentAssetId ? { attachmentUrl: `/api/assets/${m.attachmentAssetId}` } : {}),
          ...(m.assetId ? { imageUrl: `/api/assets/${m.assetId}` } : {}),
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('[api/share/:token] error:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'No se pudo cargar la conversación compartida.' }, { status: 500 })
  }
}
