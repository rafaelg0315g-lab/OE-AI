/**
 * Catálogo OE AI — deriva las entradas del catálogo a partir de los datos fuente.
 *
 * REGLAS DE HONESTIDAD:
 * - Las categorías y usos son CLASIFICACIONES INTERNAS ORIENTATIVAS derivadas del
 *   identificador (no descripciones oficiales ni capacidades verificadas).
 * - Ninguna capacidad (visión, contexto largo, herramientas, etc.) se anuncia sin
 *   verificación del proveedor o de una comprobación real.
 * - Si un ID resultara inexistente/incorrecto, se marca en CATALOG_REVIEW_NOTES
 *   (estado 'needs_review') en lugar de eliminarlo silenciosamente.
 */
import { SOURCE_MODEL_IDS } from './models.data'
import { resolveFamily } from './families'
import type { ProductCategory } from '../types'

export interface CatalogEntry {
  /** Identificador EXACTO conservado de la fuente. */
  id: string
  familyId: string
  familyLabel: string
  /** Categorías orientativas derivadas del identificador. */
  categories: ProductCategory[]
  /** Explicación orientativa del uso previsto (marcada como interna). */
  indicativeUse: string
  /** Nota de revisión si se detectó que el ID podría no existir o haber cambiado. */
  reviewNote: string | null
}

/**
 * Notas de revisión del catálogo. Si una comprobación real demuestra que un ID
 * no existe, está mal escrito o ya no está disponible, añadir aquí una entrada
 * con explicación y fecha; el modelo pasará a estado 'needs_review'.
 * Formato: { '<modelId>': 'nota con fecha' }
 */
export const CATALOG_REVIEW_NOTES: Record<string, string> = {}

/** Deduplicación defensiva (la fuente ya está deduplicada; se revalida aquí). */
function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

const INDICATIVE_USES: Record<ProductCategory, string> = {
  general: 'conversación general y asistencia',
  reasoning: 'tareas que requieren razonamiento paso a paso',
  coding: 'generación y asistencia de código',
  vision: 'entrada multimodal con imágenes',
  fast: 'respuestas rápidas y tareas ligeras',
  long_context: 'trabajo con documentos o contextos extensos',
  multilingual: 'tareas multilingües y traducción',
  safety: 'moderación y clasificación de seguridad de contenido',
  experimental: 'exploración y pruebas de capacidades nuevas',
}

/** Heurísticas de categoría derivadas del identificador (orientativas). */
function deriveCategories(id: string): ProductCategory[] {
  const stem = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const lower = stem.toLowerCase()
  const categories = new Set<ProductCategory>()

  // Visión / multimodalidad por sufijos explícitos del identificador
  if (/(^|[-.])vl([-.\d]|$)/.test(lower) || lower.includes('vision') || lower.includes('-vl') || lower.includes('autoglm')) {
    categories.add('vision')
  }
  // Programación
  if (lower.includes('coder') || lower.includes('-code') || lower.endsWith('code')) {
    categories.add('coding')
  }
  // Razonamiento
  if (/(^|[a-z0-9])r1([-.\d]|$)/.test(lower) || lower.includes('thinking') || lower.includes('reasoning')) {
    categories.add('reasoning')
  }
  // Seguridad / moderación
  if (lower.includes('guard') || lower.includes('safeguard')) {
    categories.add('safety')
  }
  // Multilingüe / traducción
  if (lower.includes('translate') || lower.includes('aya') || lower.includes('multilingual') || lower.includes('sea-lion')) {
    categories.add('multilingual')
  }
  // Experimental
  if (lower.includes('-exp') || lower.includes('preview') || /^hy\d/.test(lower)) {
    categories.add('experimental')
  }
  // Velocidad: variantes Flash/Lightning o tamaños pequeños conocidos por el nombre
  if (lower.includes('flash') || lower.includes('lightning') || /(-|b)(3b|4b|7b|8b|9b)(-|$|it)/.test(lower)) {
    categories.add('fast')
  }
  // NO se infiere 'long_context' solo por el nombre (regla de honestidad).

  if (categories.size === 0) categories.add('general')
  return [...categories]
}

function buildIndicativeUse(id: string, categories: ProductCategory[]): string {
  const uses = categories.map((c) => INDICATIVE_USES[c]).join(', ')
  return `Uso orientativo: ${uses}. Clasificación interna derivada del identificador; capacidades reales por verificar con el proveedor.`
}

function buildCatalog(): CatalogEntry[] {
  return dedupe(SOURCE_MODEL_IDS).map((id) => {
    const family = resolveFamily(id)
    const categories = deriveCategories(id)
    return {
      id,
      familyId: family.id,
      familyLabel: family.label,
      categories,
      indicativeUse: buildIndicativeUse(id, categories),
      reviewNote: CATALOG_REVIEW_NOTES[id] ?? null,
    }
  })
}

/** Catálogo construido una vez por proceso (128 entradas únicas). */
export const CATALOG: readonly CatalogEntry[] = buildCatalog()

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id)
}

export const CATALOG_FAMILY_INDEX: string[] = [...new Set(CATALOG.map((e) => e.familyId))].sort((a, b) =>
  a.localeCompare(b),
)
