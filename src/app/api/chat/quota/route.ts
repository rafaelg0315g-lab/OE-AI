import { GUEST_CHAT_LIMIT, guestCookieHeader, peekGuestQuota, resolveChatIdentity } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/chat/quota — estado de la cuota del chat.
 *
 * - Usuario autenticado (Authorization: Bearer <token> de Supabase validado
 *   en el servidor): chats ilimitados.
 * - Invitado (cookie de sesión oe_guest): `limit` chats gratis por sesión;
 *   `remaining` indica cuántos quedan antes de exigir inicio de sesión.
 */
export async function GET(request: Request) {
  try {
    const identity = await resolveChatIdentity(request)

    if (identity.kind === 'user') {
      return Response.json(
        { authenticated: true, limit: null, used: null, remaining: null },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const quota = await peekGuestQuota(identity.guestId)
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
    if (identity.isNewGuest) headers['Set-Cookie'] = guestCookieHeader(identity.guestId)

    return Response.json(
      {
        authenticated: false,
        limit: quota.limit,
        used: quota.used,
        remaining: Math.max(0, quota.limit - quota.used),
        exhausted: !quota.allowed,
      },
      { headers },
    )
  } catch {
    return Response.json(
      { authenticated: false, limit: GUEST_CHAT_LIMIT, used: 0, remaining: GUEST_CHAT_LIMIT, exhausted: false },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
