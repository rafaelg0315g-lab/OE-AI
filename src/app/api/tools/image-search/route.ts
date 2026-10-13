import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { searchWebImages } from '@/lib/ai/image-search'

export const dynamic = 'force-dynamic'
// La búsqueda web puede tardar varios segundos (sondeo de URLs + re-host OSS).
export const maxDuration = 60

/**
 * GET /api/tools/image-search?q=…&count=1
 * Busca imágenes reales de la web para los bloques :::gallery del chat.
 * Devuelve { results: [{ url, source, width, height }] }. Resultados cacheados
 * en memoria (30 min): reabrir un chat no vuelve a golpear la red.
 */
export async function GET(request: Request) {
  const requestId = crypto.randomUUID()

  // Límite propio: cada búsqueda es una llamada de red real (barata con caché).
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'tools-image-search'), 24, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Demasiadas búsquedas de imágenes seguidas. Espera unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim()
  const countRaw = Number.parseInt(url.searchParams.get('count') ?? '1', 10)
  const count = Number.isFinite(countRaw) ? Math.min(Math.max(countRaw, 1), 3) : 1

  if (q.length < 2 || q.length > 220) {
    return Response.json(
      { error: 'Consulta inválida: q debe tener entre 2 y 220 caracteres.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  const results = await searchWebImages(q, count)
  return Response.json(
    { results, requestId },
    { headers: { 'Cache-Control': 'private, max-age=300', 'X-Request-Id': requestId } },
  )
}
