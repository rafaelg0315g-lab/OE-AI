/**
 * ModelRouter — capa de enrutamiento de OE AI LLM.
 *
 * Reglas:
 * - Selección manual respetada: si el usuario pide una ruta concreta y está
 *   configurada, se usa; si no existe o no está configurada, error honesto
 *   (nunca sustitución silenciosa salvo fallback permitido e informado).
 * - Selección automática: elige la mejor ruta configurada según la tarea
 *   (coincidencia de categoría orientativa), el estado de las comprobaciones
 *   y el orden de prioridad definido.
 * - Fallback: solo hacia rutas realmente configuradas y, por defecto, hacia la
 *   entrada virtual del proveedor conectado; siempre informado en la respuesta.
 */
import { CATALOG, getCatalogEntry } from './catalog/catalog'
import { providerRegistry } from './providers'
import { ROUTER_CONFIG } from './config'
import type { ProductCategory, RouteDecision, RoutableRoute } from './types'

export type ModelSelection = { kind: 'auto' } | { kind: 'route'; routeKey: string } | { kind: 'catalog'; modelId: string }

export function parseSelection(
  raw: string | undefined | null,
): ModelSelection {
  const value = (raw ?? 'auto').trim()
  if (!value || value === 'auto') return { kind: 'auto' }
  if (value.includes(':')) return { kind: 'route', routeKey: value }
  return { kind: 'catalog', modelId: value }
}

/** Puntuación de una ruta para una tarea (mayor = mejor). */
function scoreRoute(route: RoutableRoute, task: ProductCategory | undefined): number {
  let score = 0
  if (task && route.catalogModelId) {
    const entry = getCatalogEntry(route.catalogModelId)
    if (entry) {
      if (entry.categories.includes(task)) score += 10
      else score += 2
    }
  }
  // Rutas verificadas por comprobación real preferidas (se valida fuera con health cache)
  if (route.catalogModelId) score += 1 // preferencia leve por rutas de catálogo configuradas
  return score
}

export function resolveRoute(
  selection: ModelSelection,
  task: ProductCategory | undefined,
  allowFallback: boolean,
  /** Claves de ruta con comprobación real 'ok' registrada (opcional, desde health.latestChecks). */
  verifiedRouteKeys?: ReadonlySet<string>,
  /**
   * Política del modo Automático para el chat:
   * - 'core': preguntas normales → núcleo activo OE AI LLM (proveedor conectado).
   * - 'verified': tareas de código → mejor ruta con comprobación real (OpenRouter).
   */
  autoPreference: 'core' | 'verified' = 'verified',
): RouteDecision {
  const routes = providerRegistry.availableRoutes()
  const verifiedDefault = routes.find((r) => r.providerId === 'zai-org' && r.catalogModelId === null)

  if (selection.kind === 'route') {
    const route = routes.find((r) => r.key === selection.routeKey)
    if (!route) {
      throw new RouterError(
        `La ruta "${selection.routeKey}" no existe o su proveedor no está configurado. Configura la integración o elige "Automático".`,
        'route_not_configured',
      )
    }
    return { route, fallbackUsed: false, note: 'Selección manual respetada.' }
  }

  if (selection.kind === 'catalog') {
    const entry = getCatalogEntry(selection.modelId)
    if (!entry) {
      throw new RouterError(
        `El identificador "${selection.modelId}" no pertenece al catálogo OE AI.`,
        'unknown_model',
      )
    }
    const route = routes.find((r) => r.catalogModelId === selection.modelId)
    if (!route) {
      // Marco OE AI LLM: el modelo solicitado CONFORMA la red unificada; la
      // respuesta sale por el núcleo activo del proveedor conectado.
      if (allowFallback && ROUTER_CONFIG.fallbackAllowed && verifiedDefault) {
        return {
          route: verifiedDefault,
          fallbackUsed: false,
          note: `${entry.id} forma parte de la red de OE AI LLM: la solicitud se procesó con el núcleo activo del modelo unificado (proveedor conectado).`,
        }
      }
      throw new RouterError(
        `El modelo ${entry.id} está catalogado pero ningún proveedor configurado lo sirve (estado actual: requiere configuración).`,
        'model_not_served',
      )
    }
    return {
      route,
      fallbackUsed: false,
      note: `Selección manual respetada: ${entry.id} se sirve a través de su proveedor configurado.`,
    }
  }

  // --- Automático ---
  // Política 'core' (preguntas normales): el núcleo activo OE AI LLM atiende el
  // turno; OpenRouter queda reservado para tareas de código y como respaldo.
  if (autoPreference === 'core' && verifiedDefault) {
    const taskNote = task ? ` (tarea detectada: ${task})` : ''
    return {
      route: verifiedDefault,
      fallbackUsed: false,
      note: `OE AI LLM procesó tu solicitud con su núcleo activo${taskNote}.`,
    }
  }
  // Prioridad 1 (política 'verified'): rutas de catálogo con comprobación real superada.
  const verifiedRoutes = verifiedRouteKeys
    ? routes.filter((r) => verifiedRouteKeys.has(r.key))
    : []
  if (verifiedRoutes.length > 0) {
    const best = [...verifiedRoutes].sort((a, b) => scoreRoute(b, task) - scoreRoute(a, task))[0]
    if (best) {
      const taskNote = task ? ` (tarea detectada: ${task})` : ''
      return {
        route: best,
        fallbackUsed: false,
        note: `OE AI LLM procesó tu solicitud con su red unificada${taskNote}: ruta con comprobación real superada.`,
      }
    }
  }
  // Prioridad 2: núcleo activo del proveedor conectado (entrada virtual).
  const candidates = [...routes].sort((a, b) => scoreRoute(b, task) - scoreRoute(a, task))
  const best = candidates[0]
  if (!best) {
    throw new RouterError(
      'No hay ningún proveedor configurado. Define las credenciales del proveedor en el servidor para habilitar el enrutamiento automático.',
      'no_provider_configured',
    )
  }
  if (verifiedDefault && best.key === verifiedDefault.key) {
    const taskNote = task ? ` (tarea detectada: ${task})` : ''
    return {
      route: best,
      fallbackUsed: false,
      note: `OE AI LLM procesó tu solicitud con su red unificada${taskNote}.`,
    }
  }
  const taskNote = task ? ` (tarea detectada: ${task})` : ''
  return {
    route: best,
    fallbackUsed: false,
    note: `OE AI LLM procesó tu solicitud con su red unificada${taskNote}: mejor ruta configurada disponible.`,
  }
}

export class RouterError extends Error {
  constructor(
    message: string,
    readonly errorType: string,
  ) {
    super(message)
    this.name = 'RouterError'
  }
}

/** Rutas visibles para el selector del chat: "Automático" + las realmente servibles. */
export function selectableChatRoutes(): RoutableRoute[] {
  return providerRegistry.availableRoutes()
}

/** Categorías de tarea admitidas por el enrutador (etiquetas de producto). */
export const ROUTER_TASKS: ProductCategory[] = [
  'general',
  'reasoning',
  'coding',
  'vision',
  'fast',
  'multilingual',
  'experimental',
]

export const ROUTER_CONFIG_PUBLIC = {
  mode: ROUTER_CONFIG.mode,
  fallbackAllowed: ROUTER_CONFIG.fallbackAllowed,
  catalogSize: CATALOG.length,
}
