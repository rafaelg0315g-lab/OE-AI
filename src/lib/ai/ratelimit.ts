/**
 * Limitador de peticiones en memoria (ventana deslizante).
 * Válido para una única instancia de servidor; documentado como limitación.
 */
const buckets = new Map<string, number[]>()

// Limpieza periódica para evitar crecimiento ilimitado.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
let lastCleanup = Date.now()

function maybeCleanup(now: number, windowMs: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  for (const [key, hits] of buckets) {
    const alive = hits.filter((t) => now - t < windowMs)
    if (alive.length === 0) buckets.delete(key)
    else buckets.set(key, alive)
  }
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  maybeCleanup(now, windowMs)
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    const oldest = hits[0]
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, oldest + windowMs - now),
    }
  }
  hits.push(now)
  buckets.set(key, hits)
  return { allowed: true, remaining: limit - hits.length, retryAfterMs: 0 }
}

export function clientKeyFromHeaders(headers: Headers, prefix: string): string {
  const forwarded = headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : headers.get('x-real-ip') ?? 'local'
  return `${prefix}:${ip}`
}
