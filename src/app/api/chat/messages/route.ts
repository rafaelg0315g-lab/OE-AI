import { z } from 'zod'
import { db } from '@/lib/db'
import { resolveAuthUser } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'

const PatchMessageSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{6,45}$/i),
  content: z.string().min(1).max(60_000),
})

/**
 * PATCH /api/chat/messages — actualiza el contenido de un mensaje ya persistido.
 * Uso único del Constructor: tras generar la app, el cliente sustituye la
 * directiva ```oe-build del mensaje del asistente por el bloque ```oeproject
 * (tarjetas de archivos), para que el historial muestre siempre el resultado.
 * PRIVACIDAD: si el chat del mensaje tiene propietario, solo su dueño puede
 * actualizarlo.
 */
export async function PATCH(request: Request) {
  try {
    const body = PatchMessageSchema.parse(await request.json())
    const message = await db.chatMessage.findUnique({
      where: { id: body.id },
      select: { id: true, session: { select: { ownerKey: true } } },
    })
    if (!message) return Response.json({ error: 'Mensaje no encontrado.' }, { status: 404 })
    if (message.session.ownerKey) {
      const caller = await resolveAuthUser(request)
      if (!caller || caller.supabaseId !== message.session.ownerKey) {
        return Response.json({ error: 'Este chat es privado o no existe.' }, { status: 404 })
      }
    }
    await db.chatMessage.update({ where: { id: body.id }, data: { content: body.content } })
    return Response.json({ ok: true })
  } catch {
    return Response.json({ error: 'Payload inválido para actualizar el mensaje.' }, { status: 400 })
  }
}
