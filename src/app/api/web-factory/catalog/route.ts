import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { ensureCatalog, refreshFromGitHub } from '@/lib/web-factory/catalog'

export const dynamic = 'force-dynamic'

/**
 * GET /api/web-factory/catalog — biblioteca de plantillas y componentes con su
 * procedencia y licencia. Siembra el catálogo curado si está vacío (sin red).
 */
export async function GET() {
  try {
    const counts = await ensureCatalog()
    const [templates, components] = await Promise.all([
      db.webTemplate.findMany({
        orderBy: [{ status: 'asc' }, { stars: 'desc' }, { name: 'asc' }],
        take: 60,
      }),
      db.webComponent.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], take: 80 }),
    ])
    return Response.json({
      counts,
      updatedAt: templates[0]?.lastReviewedAt ?? null,
      templates: templates.map((t) => ({
        ...t,
        tags: safeTags(t.tags),
      })),
      components: components.map((c) => ({
        ...c,
        tags: safeTags(c.tags),
      })),
    })
  } catch (err) {
    console.error('[api/web-factory/catalog] error:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'No se pudo cargar el catálogo.' }, { status: 500 })
  }
}

/** POST — refresco manual bajo demanda (descubrimiento desde GitHub). */
export async function POST(request: Request) {
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'web-factory-refresh'), 2, 300_000)
  if (!rl.allowed) {
    return Response.json({ error: 'Refresco limitado. Espera unos minutos.' }, { status: 429 })
  }
  const result = await refreshFromGitHub()
  return Response.json({
    added: result.added,
    errors: result.errors,
    note: result.errors.length > 0 ? 'Algunas consultas a GitHub fallaron (cuota/red); el catálogo curado sigue disponible.' : 'Catálogo actualizado desde GitHub.',
  })
}

function safeTags(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 8) : []
  } catch {
    return []
  }
}
