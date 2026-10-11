import { db } from '@/lib/db'

/**
 * Identidad y cuota del chat.
 *
 * - Usuario autenticado: cabecera `Authorization: Bearer <access_token>` de
 *   Supabase. El token se valida contra `GET {SUPABASE_URL}/auth/v1/user`
 *   (fuente de verdad) con una caché en memoria de corta duración para no
 *   añadir latencia a cada mensaje. Nunca se confía en datos del cliente.
 * - Invitado: cookie de sesión `oe_guest` (sin Max-Age: expira al cerrar el
 *   navegador). Cada inicio de sesión del navegador dispone de una cuota
 *   fresca de chats gratis; al agotarla se exige iniciar sesión.
 */

export const GUEST_COOKIE_NAME = 'oe_guest'

/** Chats gratis por sesión de invitado (requisito del producto). */
export const GUEST_CHAT_LIMIT = 5

export type ChatIdentity =
  | { kind: 'user'; supabaseId: string; email: string }
  | { kind: 'guest'; guestId: string; isNewGuest: boolean }

/* ── Caché de validación de tokens (solo proceso, sin datos personales) ────── */

type CachedValidation = { supabaseId: string; email: string; expiresAt: number }

const tokenCache = new Map<string, CachedValidation>()
const NEGATIVE_TTL_MS = 60_000
const POSITIVE_TTL_MS = 5 * 60_000
const TOKEN_CACHE_MAX = 512

function cacheGet(token: string): CachedValidation | null | undefined {
  const hit = tokenCache.get(`ok:${token}`)
  if (hit) return hit.expiresAt > Date.now() ? hit : undefined
  const neg = tokenCache.get(`bad:${token}`)
  if (neg) return neg.expiresAt > Date.now() ? null : undefined
  return undefined
}

function cachePut(token: string, value: CachedValidation | null): void {
  if (tokenCache.size > TOKEN_CACHE_MAX) tokenCache.clear()
  const ttl = value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS
  const stored: CachedValidation = value
    ? { ...value, expiresAt: Date.now() + POSITIVE_TTL_MS }
    : { supabaseId: '', email: '', expiresAt: Date.now() + NEGATIVE_TTL_MS }
  tokenCache.set(`${value ? 'ok' : 'bad'}:${token}`, stored)
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

/** Valida un access token de Supabase contra el servidor de auth (con caché). */
async function validateSupabaseToken(token: string): Promise<CachedValidation | null> {
  const cached = cacheGet(token)
  if (cached !== undefined) return cached

  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!projectUrl || !anonKey) return null

  try {
    const res = await fetch(`${projectUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (!res.ok) {
      cachePut(token, null)
      return null
    }
    const user = (await res.json()) as { id?: string; email?: string }
    if (!user?.id || !user?.email) {
      cachePut(token, null)
      return null
    }
    const value: CachedValidation = { supabaseId: user.id, email: user.email, expiresAt: 0 }
    cachePut(token, value)
    return value
  } catch {
    // Red hacia Supabase caída: se trata como invitado (fallo abierto, honesto).
    return null
  }
}

/* ── Cookie de sesión de invitado ──────────────────────────────────────────── */

function readGuestCookie(request: Request): string | null {
  const cookie = request.headers.get('cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === GUEST_COOKIE_NAME) {
      const value = rest.join('=')
      // Solo uuids con formato razonable
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value
      return null
    }
  }
  return null
}

/** Cabecera Set-Cookie de sesión (expira al cerrar el navegador). */
export function guestCookieHeader(guestId: string): string {
  return `${GUEST_COOKIE_NAME}=${guestId}; Path=/; HttpOnly; SameSite=Lax`
}

/** Resuelve la identidad del chat: usuario verificado o invitado (cookie). */
export async function resolveChatIdentity(request: Request): Promise<ChatIdentity> {
  const token = bearerFrom(request)
  if (token) {
    const verified = await validateSupabaseToken(token)
    if (verified) return { kind: 'user', supabaseId: verified.supabaseId, email: verified.email }
  }
  const existing = readGuestCookie(request)
  if (existing) return { kind: 'guest', guestId: existing, isNewGuest: false }
  return { kind: 'guest', guestId: crypto.randomUUID(), isNewGuest: true }
}

/**
 * Resuelve SOLO el usuario verificado (sin invitados): supabaseId del portador
 * del token o null. Para endpoints donde la pertenencia importa (historial
 * privado, sesiones, compartir): sin token válido no hay identidad.
 */
export async function resolveAuthUser(request: Request): Promise<{ supabaseId: string; email: string } | null> {
  const token = bearerFrom(request)
  if (!token) return null
  const verified = await validateSupabaseToken(token)
  return verified ? { supabaseId: verified.supabaseId, email: verified.email } : null
}

/* ── Cuota de invitado ─────────────────────────────────────────────────────── */

export type GuestQuotaDecision = { allowed: boolean; used: number; limit: number }

/** Consulta la cuota de un invitado sin consumirla. */
export async function peekGuestQuota(guestId: string): Promise<GuestQuotaDecision> {
  const row = await db.guestUsage.findUnique({ where: { guestId }, select: { chatCount: true } })
  const used = row?.chatCount ?? 0
  return { allowed: used < GUEST_CHAT_LIMIT, used, limit: GUEST_CHAT_LIMIT }
}

/**
 * Consume un chat de la cuota del invitado.
 * Se llama solo cuando la solicitud ya superó validación y resolución de ruta:
 * los errores de infraestructura propia no queman chats del usuario.
 */
export async function consumeGuestChat(guestId: string): Promise<GuestQuotaDecision> {
  const row = await db.guestUsage.upsert({
    where: { guestId },
    create: { guestId, chatCount: 1 },
    update: { chatCount: { increment: 1 } },
    select: { chatCount: true },
  })
  return { allowed: row.chatCount <= GUEST_CHAT_LIMIT, used: row.chatCount, limit: GUEST_CHAT_LIMIT }
}
