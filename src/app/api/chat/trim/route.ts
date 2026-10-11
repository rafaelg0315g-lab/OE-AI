import { z } from 'zod'
import { db } from '@/lib/db'
import { resolveAuthUser } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'

const TrimBodySchema = z.object({
  sessionId: z.string().uuid(),
  /** Número de mensajes (ordenados por creación) que se CONSERVAN al inicio. */
  keepCount: z.number().int().min(0).max(500),
})

/**
 * POST /api/chat/trim — elimina los mensajes posteriores a una posición.
 * Se usa al EDITAR un mensaje del usuario: se recorta la rama antigua y el
 * texto corregido se envía como mensaje nuevo.
 * PRIVACIDAD: si el chat tiene propietario, solo su dueño puede recortarlo.
 */
export async function POST(request: Request) {
  try {
    const body = TrimBodySchema.parse(await request.json())
    const session = await db.chatSession.findUnique({
      where: { id: body.sessionId },
      select: { ownerKey: true },
    })
    if (session?.ownerKey) {
      const caller = await resolveAuthUser(request)
      if (!caller || caller.supabaseId !== session.ownerKey) {
        return Response.json({ error: 'Este chat es privado o no existe.' }, { status: 404 })
      }
    }
    const later = await db.chatMessage.findMany({
      where: { sessionId: body.sessionId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      skip: body.keepCount,
    })
    if (later.length === 0) {
      return Response.json({ ok: true, deleted: 0 })
    }
    const deleted = await db.chatMessage.deleteMany({ where: { id: { in: later.map((m) => m.id) } } })
    return Response.json({ ok: true, deleted: deleted.count })
  } catch {
    return Response.json({ error: 'Payload inválido: sessionId (uuid) y keepCount (0-500) son obligatorios.' }, { status: 400 })
  }
}
