import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { guestCookieHeader, resolveChatIdentity } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'

const MAX_ITEMS = 50

const MemoryPostSchema = z.object({
  fact: z.string().min(1).max(300),
})

/**
 * Resuelve el ownerKey de la memoria: id de Supabase si hay sesión verificada;
 * si no, el id de invitado de la cookie oe_guest (misma identidad que la
 * cuota). Si el invitado es nuevo, devuelve la cabecera Set-Cookie para que
 * su memoria (y cuota) queden fijadas desde esta misma respuesta.
 */
async function resolveOwnerKey(
  request: Request,
): Promise<{ ownerKey: string | null; setCookie: string | null }> {
  try {
    const identity = await resolveChatIdentity(request)
    if (identity.kind === 'user') return { ownerKey: identity.supabaseId, setCookie: null }
    return {
      ownerKey: identity.guestId,
      setCookie: identity.isNewGuest ? guestCookieHeader(identity.guestId) : null,
    }
  } catch (err) {
    console.error('[api/memory] identidad no disponible:', err instanceof Error ? err.message : err)
    return { ownerKey: null, setCookie: null }
  }
}

/**
 * GET /api/memory — memoria personalizada del usuario/invitado (máx. 50,
 * más recientes primero). Si el navegador es nuevo, la lista es vacía y la
 * respuesta fija la cookie de sesión de invitado.
 */
export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'memory-get'), 60, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Demasiadas consultas de memoria. Espera unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }
  const { ownerKey, setCookie } = await resolveOwnerKey(request)
  if (!ownerKey) {
    return Response.json(
      { error: 'No se pudo resolver la identidad del usuario.', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    )
  }
  try {
    const rows = await db.chatMemory.findMany({
      where: { ownerKey },
      orderBy: { createdAt: 'desc' },
      take: MAX_ITEMS,
      select: { id: true, fact: true, createdAt: true },
    })
    return Response.json(
      { items: rows.map((r) => ({ id: r.id, fact: r.fact, createdAt: r.createdAt.toISOString() })) },
      { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) } },
    )
  } catch (err) {
    console.error('[api/memory] error GET:', err instanceof Error ? err.message : err)
    return Response.json(
      { error: 'No se pudo cargar la memoria.', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    )
  }
}

/**
 * POST /api/memory — añade un dato a recordar (1-300 caracteres).
 * Evita duplicados exactos del mismo propietario (devuelve la fila existente).
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'memory-post'), 30, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Demasiadas escrituras de memoria. Espera unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }
  let body: z.infer<typeof MemoryPostSchema>
  try {
    body = MemoryPostSchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: 'Payload inválido: fact (1-300 caracteres) es obligatorio.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }
  const { ownerKey, setCookie } = await resolveOwnerKey(request)
  if (!ownerKey) {
    return Response.json(
      { error: 'No se pudo resolver la identidad del usuario.', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    )
  }
  try {
    const fact = body.fact.trim().slice(0, 300)
    const existing = await db.chatMemory.findFirst({
      where: { ownerKey, fact },
      select: { id: true, fact: true, createdAt: true },
    })
    if (existing) {
      return Response.json(
        { id: existing.id, fact: existing.fact, duplicate: true, requestId },
        { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) } },
      )
    }
    const created = await db.chatMemory.create({
      data: { ownerKey, fact },
      select: { id: true, fact: true },
    })
    return Response.json(
      { id: created.id, fact: created.fact, requestId },
      { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) } },
    )
  } catch (err) {
    console.error('[api/memory] error POST:', err instanceof Error ? err.message : err)
    return Response.json(
      { error: 'No se pudo guardar el dato en la memoria.', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    )
  }
}

/**
 * DELETE /api/memory?id=… — borra un dato SOLO si pertenece al ownerKey.
 * Un id ajeno o inexistente responde 404 (sin revelar existencia).
 */
export async function DELETE(request: Request) {
  const requestId = crypto.randomUUID()
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'memory-delete'), 30, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Demasiadas operaciones de memoria. Espera unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (!/^[a-z0-9_-]{10,40}$/i.test(id)) {
    return Response.json(
      { error: 'Identificador de memoria inválido.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }
  const { ownerKey } = await resolveOwnerKey(request)
  if (!ownerKey) {
    return Response.json(
      { error: 'No se pudo resolver la identidad del usuario.', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    )
  }
  try {
    const row = await db.chatMemory.findUnique({ where: { id }, select: { ownerKey: true } })
    if (!row || row.ownerKey !== ownerKey) {
      return Response.json(
        { error: 'Ese dato de memoria no existe o no es tuyo.', requestId },
        { status: 404, headers: { 'X-Request-Id': requestId } },
      )
    }
    await db.chatMemory.delete({ where: { id } })
    return Response.json(
      { ok: true, requestId },
      { headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
    )
  } catch (err) {
    console.error('[api/memory] error DELETE:', err instanceof Error ? err.message : err)
    return Response.json(
      { error: 'No se pudo borrar el dato de la memoria.', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    )
  }
}
