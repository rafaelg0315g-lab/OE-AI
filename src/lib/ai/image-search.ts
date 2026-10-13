/**
 * Búsqueda de imágenes reales de la web (canvas visual del chat).
 *
 * Usa el servicio de búsqueda de imágenes del núcleo z-ai (SDK del entorno),
 * que devuelve URLs ya re-hosteadas en OSS (estables e incrustables) más la
 * fuente original. Las consultas se cachean en memoria (TTL) para que el
 * re-render del historial y las respuestas repetidas no vuelvan a golpear la
 * red, y las peticiones simultáneas a la misma consulta comparten promesa.
 *
 * Solo servidor: el SDK requiere credenciales del entorno OE.
 */

export interface WebImageHit {
  url: string
  source?: string
  caption?: string
  width?: number
  height?: number
}

const CACHE_TTL_MS = 30 * 60_000
const CACHE_MAX_ENTRIES = 200

type CacheEntry = { at: number; hits: WebImageHit[] }
const cache = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<WebImageHit[]>>()

function cacheGet(key: string): WebImageHit[] | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return entry.hits
}

function cacheSet(key: string, hits: WebImageHit[]) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Evicción simple: la entrada más antigua.
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [k, v] of cache) {
      if (v.at < oldestAt) {
        oldestAt = v.at
        oldestKey = k
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }
  cache.set(key, { at: Date.now(), hits })
}

function parsePx(value?: string): number | undefined {
  if (!value) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

async function zaiImageSearch(query: string, count: number): Promise<WebImageHit[]> {
  const { default: ZAI } = await import('z-ai-web-dev-sdk')
  const zai = await ZAI.create()
  const res = await zai.images.search.create({
    query: trimmed(query),
    count: Math.min(Math.max(count, 1), 6),
    gl: 'us',
    rank: false,
  })
  if (!res?.success || !Array.isArray(res.results)) {
    throw new Error(res?.error ?? 'respuesta sin éxito')
  }
  return res.results
    .filter((r) => typeof r.original_url === 'string' && r.original_url.startsWith('http'))
    .slice(0, count)
    .map((r) => ({
      url: r.original_url,
      source: r.source ?? undefined,
      caption: r.caption ?? undefined,
      width: parsePx(r.original_width),
      height: parsePx(r.original_height),
    }))
}

function trimmed(query: string): string {
  return query.trim().slice(0, 220)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Busca imágenes en la web para una consulta en lenguaje natural.
 * Devuelve hasta `count` resultados (URL OSS estable). Nunca lanza: ante
 * fallo devuelve [] para que la UI degrade con un marcador. Un 429 del
 * upstream se reintenta una vez con backoff (se resuelve en segundos).
 */
export async function searchWebImages(query: string, count = 1): Promise<WebImageHit[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const key = `${count}::${q.toLowerCase().slice(0, 220)}`

  const cached = cacheGet(key)
  if (cached) return cached

  const inflight = pending.get(key)
  if (inflight) return inflight

  const task = (async (): Promise<WebImageHit[]> => {
    try {
      let hits: WebImageHit[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          hits = await zaiImageSearch(q, count)
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const is429 = msg.includes('429')
          if (attempt === 0 && is429) {
            await sleep(2500)
            continue
          }
          console.error('[image-search] fallo de búsqueda:', msg.slice(0, 140))
          return []
        }
      }
      if (hits.length > 0) cacheSet(key, hits)
      return hits
    } finally {
      pending.delete(key)
    }
  })()

  pending.set(key, task)
  return task
}
