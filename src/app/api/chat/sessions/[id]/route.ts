import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { resolveAuthUser } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'

const RenameSchema = z.object({ title: z.string().min(1).max(80) })

/**
 * Guardián de pertenencia: 404 si la sesión no existe o es de otro usuario.
 * Sesiones sin dueño (invitados/legado) se manejan como antes (el uuid es la
 * credencial aleatoria).
 */
async function ownedSessionOr404(id: string, request: Request) {
  const session = await db.chatSession.findUnique({ where: { id }, select: { ownerKey: true } })
  if (!session) return { error: 'Conversación no encontrada.' as const }
  if (session.ownerKey) {
    const caller = await resolveAuthUser(request)
    if (!caller || caller.supabaseId !== session.ownerKey) {
      return { error: 'Este chat es privado o no existe.' as const }
    }
  }
  return { session }
}

/**
 * PATCH /api/chat/sessions/[id] — renombra una conversación del historial
 * (solo su propietario).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const body = RenameSchema.parse(await request.json())
    const guard = await ownedSessionOr404(id, request)
    if ('error' in guard) {
      return NextResponse.json({ error: guard.error }, { status: 404 })
    }
    const updated = await db.chatSession.update({
      where: { id },
      data: { title: body.title.trim() },
      select: { id: true, title: true, updatedAt: true },
    })
    return NextResponse.json({ ok: true, session: updated })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Título inválido (1-80 caracteres).' }, { status: 400 })
    }
    console.error('[api/chat/sessions/:id] rename error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No se pudo renombrar la conversación.' }, { status: 500 })
  }
}

/**
 * DELETE /api/chat/sessions/[id] — elimina una conversación del historial
 * (los mensajes se borran en cascada por la relación de Prisma). Solo el
 * propietario puede eliminarla.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const guard = await ownedSessionOr404(id, request)
    if ('error' in guard) {
      return NextResponse.json({ error: guard.error }, { status: 404 })
    }
    await db.chatSession.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[api/chat/sessions/:id] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No se pudo eliminar la conversación.' }, { status: 500 })
  }
}
