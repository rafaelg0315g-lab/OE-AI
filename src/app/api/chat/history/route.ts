import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { resolveAuthUser } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({ sessionId: z.string().uuid() })

/**
 * GET /api/chat/history?sessionId=<uuid> — restaurar una conversación.
 *
 * PRIVACIDAD: los chats con propietario (ownerKey = supabaseId, fijado en
 * servidor) solo los puede leer su dueño con un token válido; para cualquier
 * otra persona la respuesta es 404, indistinguible de un chat inexistente.
 * Sesiones sin dueño (invitados demo / legado) siguen accesibles con el uuid,
 * que actúa como credencial aleatoria — pero nunca aparecen en historiales.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({ sessionId: url.searchParams.get('sessionId') ?? '' })
  if (!parsed.success) {
    return NextResponse.json({ error: 'sessionId inválido.' }, { status: 400 })
  }
  const session = await db.chatSession.findUnique({
    where: { id: parsed.data.sessionId },
    select: { id: true, title: true, ownerKey: true, createdAt: true },
  })
  if (!session) {
    return NextResponse.json({ error: 'Este chat es privado o no existe.' }, { status: 404 })
  }
  if (session.ownerKey) {
    const caller = await resolveAuthUser(request)
    if (!caller || caller.supabaseId !== session.ownerKey) {
      // 404 (no 403): no se revela ni la existencia del chat.
      return NextResponse.json({ error: 'Este chat es privado o no existe.' }, { status: 404 })
    }
  }
  const messages = await db.chatMessage.findMany({
    where: { sessionId: parsed.data.sessionId, status: 'ok' },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: {
      id: true,
      role: true,
      content: true,
      kind: true,
      assetId: true,
      attachmentAssetId: true,
      sourcesJson: true,
      requestedModelId: true,
      resolvedModelId: true,
      providerId: true,
      providerReportedModel: true,
      fallbackUsed: true,
      latencyMs: true,
      createdAt: true,
    },
  })
  return NextResponse.json(
    {
      session: { id: session.id, title: session.title, createdAt: session.createdAt.toISOString() },
      messages: messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
