/**
 * Tipos y utilidades compartidas del Centro de APIs (/apis).
 * Espejo exacto de las respuestas públicas de GET /api/models y GET /api/models/[id].
 * Regla del proyecto: nunca tipar respuestas como `any`.
 */
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

/** Estados de integración que puede reportar la API. */
export type ApiModelStatus =
  | 'network_member'
  | 'connected'
  | 'available_with_config'
  | 'not_verified'
  | 'temporarily_unavailable'
  | 'planned'
  | 'needs_review'

/** Etiquetas en español de los estados (coinciden con las que envía la API). */
export const STATUS_LABELS_ES: Record<ApiModelStatus, string> = {
  network_member: 'En la red OE AI LLM',
  connected: 'Conectado',
  available_with_config: 'Disponible con configuración',
  not_verified: 'No verificado',
  temporarily_unavailable: 'Temporalmente no disponible',
  planned: 'En planificación',
  needs_review: 'Revisión necesaria',
}

/** Orden de severidad para «Ordenar por estado» (mejor estado primero). */
export const STATUS_SORT_ORDER: ApiModelStatus[] = [
  'network_member',
  'connected',
  'available_with_config',
  'not_verified',
  'temporarily_unavailable',
  'needs_review',
  'planned',
]

/** Etiquetas en español de las categorías orientativas del catálogo. */
export const CATEGORY_LABELS_ES: Record<string, string> = {
  general: 'General y conversación',
  reasoning: 'Razonamiento',
  coding: 'Programación',
  vision: 'Visión y multimodalidad',
  fast: 'Velocidad y tareas ligeras',
  long_context: 'Contexto largo',
  multilingual: 'Multilingüe y traducción',
  safety: 'Seguridad y moderación',
  experimental: 'Experimental',
}

/** Etiquetas legibles para capacidades verificadas (siempre en español). */
export const CAPABILITY_LABELS_ES: Record<string, string> = {
  chat: 'Chat',
  streaming: 'Streaming de tokens',
  vision: 'Visión',
  coding: 'Programación',
  tool_use: 'Uso de herramientas',
  json_mode: 'Salida JSON',
}

/** Proveedor vinculado a un modelo concreto (ruta de servicio real). */
export interface ApiProviderLink {
  providerId: string
  providerLabel: string
  configured: boolean
  lastCheckStatus: string | null
  lastCheckedAt: string | null
}

/** Modelo del catálogo público (GET /api/models). */
export interface ApiModel {
  /** ID exacto del modelo, puede contener «/» (p. ej. "zai-org/GLM-5.3-Flash"). */
  id: string
  familyId: string
  familyLabel: string
  categories: string[]
  indicativeUse: string
  status: ApiModelStatus
  statusLabel: string
  verifiedCapabilities: string[]
  providers: ApiProviderLink[]
  lastCheckedAt: string | null
  lastCheckNote: string | null
  reviewNote: string | null
  chatEnabled: boolean
  testable: boolean
  detailUrl: string
}

/** Contadores calculados en el servidor desde el registro real. */
export interface ApiCounters {
  total: number
  connected: number
  networkMembers: number
  providersConfigured: number
  providersRegistered: number
  visionVerified: number
  codingVerified: number
  families: number
  source: string
}

/** Resumen de un proveedor registrado (sin valores secretos). */
export interface ApiProviderSummary {
  id: string
  label: string
  configured: boolean
  status: ApiModelStatus
  statusLabel: string
  capabilities: { chat: boolean; streaming: boolean; modelSelection: boolean }
  endpointStatus: string
  envVarNames: string[]
  note: string
  servesDefault: boolean
}

/** Respuesta completa de GET /api/models. */
export interface ApiModelsResponse {
  oeAiLlm: {
    name: string
    status: 'ready'
    statusLabel: string
    tagline: string
    description: string
    coreProviderId: string
    coreLabel: string
  }
  models: ApiModel[]
  counters: ApiCounters
  families: string[]
  categories: string[]
  providers: ApiProviderSummary[]
  router: { mode: string; fallbackAllowed: boolean; defaultRouteLabel: string | null }
  publicApi: { enabled: boolean; status: ApiModelStatus }
  sourceNote: string
}

/** Comprobación individual registrada para un modelo. */
export interface ApiModelCheck {
  status: string
  note: string | null
  checkedAt: string
  latencyMs: number | null
}

/** Detalle de un modelo (GET /api/models/[id]): modelo + historial y notas. */
export interface ApiModelDetail extends ApiModel {
  checks: ApiModelCheck[]
  familyNote: string | null
  costNote: string
  contextNote: string
}

/** Opciones de ordenación del catálogo. */
export type ModelSortOption = 'name_asc' | 'name_desc' | 'family' | 'status'

/** Nombre visible de un modelo: la parte posterior al último «/» del ID exacto. */
export function visibleModelName(id: string): string {
  const idx = id.lastIndexOf('/')
  return idx >= 0 ? id.slice(idx + 1) : id
}

/**
 * Formatea una fecha ISO en español con date-fns.
 * Devuelve cadena vacía si la fecha no es válida.
 */
export function formatDateTimeEs(iso: string, withTime = true): string {
  try {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    return withTime
      ? format(date, 'd MMM yyyy · HH:mm', { locale: es })
      : format(date, 'd MMM yyyy', { locale: es })
  } catch {
    return ''
  }
}
