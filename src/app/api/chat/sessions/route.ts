import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveAuthUser } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'

/**
 * GET /api/chat/sessions — historial del sidebar (metadatos solamente).
 *
 * PRIVACIDAD: devuelve ÚNICAMENTE las conversaciones propias del usuario
 * verificado (token Supabase). Invitados demo: lista vacía — su chat es
 * efímero y sin historial.
 */
export async function GET(request: Request) {
  try {
    const caller = await resolveAuthUser(request)
    if (!caller) {
      return NextResponse.json({ sessions: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const sessions = await db.chatSession.findMany({
      where: { ownerKey: caller.supabaseId },
      orderBy: { updatedAt: 'desc' },
      take: 60,
      include: { _count: { select: { messages: true } } },
    })
    return NextResponse.json(
      {
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          messageCount: s._count.messages,
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('[api/chat/sessions] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No se pudo cargar el historial.' }, { status: 500 })
  }
}
