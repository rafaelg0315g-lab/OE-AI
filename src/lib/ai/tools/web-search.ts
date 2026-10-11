import type ZAI from 'z-ai-web-dev-sdk'

/** Fuente web normalizada que viaja al cliente y se persiste con el mensaje. */
export interface WebSource {
  name: string
  url: string
  hostName: string
  snippet: string
  date: string | null
}

interface RawSearchItem {
  url?: unknown
  name?: unknown
  snippet?: unknown
  host_name?: unknown
  date?: unknown
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * Búsqueda web real vía el proveedor conectado (solo servidor).
 * Devuelve hasta `num` fuentes normalizadas; lanza si el proveedor falla.
 */
export async function searchWeb(zai: Awaited<ReturnType<typeof ZAI.create>>, query: string, num = 6): Promise<WebSource[]> {
  const raw = (await zai.functions.invoke('web_search', { query: query.slice(0, 380), num })) as unknown
  if (!Array.isArray(raw)) {
    throw new Error('El proveedor de búsqueda no devolvió resultados utilizables.')
  }
  const sources: WebSource[] = []
  for (const item of raw as RawSearchItem[]) {
    const url = str(item.url, 500)
    const name = str(item.name, 160)
    if (!url || !name) continue
    let hostName = str(item.host_name, 120)
    if (!hostName) {
      try {
        hostName = new URL(url).hostname
      } catch {
        hostName = 'web'
      }
    }
    sources.push({
      name,
      url,
      hostName,
      snippet: str(item.snippet, 320),
      date: str(item.date, 40) || null,
    })
    if (sources.length >= num) break
  }
  return sources
}

/** Bloque de contexto que se inyecta al modelo cuando hay búsqueda web. */
export function buildSearchContext(sources: WebSource[]): string {
  if (sources.length === 0) return ''
  const lines = sources.map((s, i) => `[${i + 1}] ${s.name} — ${s.hostName}${s.date ? ` (${s.date})` : ''}\n${s.snippet}`)
  return [
    'Resultados de búsqueda web recientes (podrían estar incompletos):',
    ...lines,
    '',
    'Instrucciones: responde con esa información cuando sea relevante, cita las fuentes con corchetes [1], [2]… y aclara si algo no aparece en los resultados.',
  ].join('\n')
}
