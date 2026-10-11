/**
 * Contratos comunes de OE AI LLM (capa de orquestación multimodelo).
 *
 * OE AI LLM NO es un modelo fundacional: es una capa que coordina modelos de
 * terceros a través de adaptadores de proveedor, normaliza respuestas y aplica
 * políticas de enrutamiento, fallback, límites y registro de uso.
 */

/** Estados de integración (siempre derivados de configuración/comprobaciones reales). */
export type IntegrationStatus =
  | 'connected' // Conectado: configurado + comprobación real superada
  | 'network_member' // Miembro activo de la red que conforma OE AI LLM
  | 'available_with_config' // Disponible con configuración: adaptador listo, faltan credenciales/configuración
  | 'not_verified' // En catálogo, sin verificación individual
  | 'temporarily_unavailable' // Configurado pero la última comprobación falló
  | 'planned' // En planificación (p. ej. endpoint público no implementado aún)
  | 'needs_review' // Revisión necesaria: el ID pudo dejar de existir o estar mal escrito

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  connected: 'Conectado',
  network_member: 'En la red OE AI LLM',
  available_with_config: 'Disponible con configuración',
  not_verified: 'No verificado',
  temporarily_unavailable: 'Temporalmente no disponible',
  planned: 'En planificación',
  needs_review: 'Revisión necesaria',
}

/** Categorías de producto (etiquetas iniciales internas, no afirmaciones oficiales). */
export const PRODUCT_CATEGORIES = [
  'general',
  'reasoning',
  'coding',
  'vision',
  'fast',
  'long_context',
  'multilingual',
  'safety',
  'experimental',
] as const

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<ProductCategory, string> = {
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

/**
 * Mensaje normalizado hacia/desde adaptadores.
 * Parte de contenido multimodal (formato compatible OpenAI): texto y/o imagen.
 * La visión la sirve el núcleo z-ai vía chat.completions.createVision.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatRequestMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

/** Longitud de texto de un mensaje (contabiliza solo las partes de texto). */
export function messageChars(m: ChatRequestMessage): number {
  if (typeof m.content === 'string') return m.content.length
  return m.content.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0)
}

/** Entrada de ruta que un adaptador puede servir realmente. */
export interface RoutableRoute {
  /** Clave estable de la ruta: '<providerId>:<providerModelId|default>'. */
  key: string
  providerId: string
  /** ID de catálogo al que apunta la ruta; null = entrada virtual (modelo predeterminado del proveedor). */
  catalogModelId: string | null
  /** Identificador que se envía al proveedor (cuando el adaptador soporta selección). */
  providerModelId: string
  /** Etiqueta visible honesta. */
  label: string
  /** La ruta proviene de configuración de administrador (OE_AI_MODEL_ROUTES). */
  fromAdminConfig: boolean
}

/** Respuesta normalizada de un adaptador. */
export interface NormalizedCompletion {
  content: string
  /** Modelo que el PROVEEDOR reporta en la respuesta (si lo informa). */
  providerReportedModel: string | null
  latencyMs: number
  promptChars: number
  completionChars: number
}

export interface AdapterChatOptions {
  messages: ChatRequestMessage[]
  providerModelId: string
  signal?: AbortSignal
}

/** Evento de streaming normalizado: incremento de texto del asistente. */
export interface AdapterStreamEvent {
  delta: string
}

/**
 * Resultado final del streaming: mismo contrato que NormalizedCompletion.
 * `content` es el texto completo acumulado (verificado por el adaptador).
 */
export type AdapterStreamResult = NormalizedCompletion

export interface AdapterStreamSession {
  /** Consume el stream; devuelve el resultado final normalizado. */
  next(): Promise<{ value: AdapterStreamEvent | AdapterStreamResult; done: boolean }>
  /** true cuando el generador terminó y `next()` devolvió el resultado final. */
  finished: boolean
}

/** Contrato común de adaptador de proveedor. */
export interface AIProviderAdapter {
  id: string
  label: string
  /** Nombres de variables de entorno (nunca valores). */
  envVarNames: string[]
  isConfigured(): boolean
  capabilities: {
    chat: boolean
    /** Streaming verificado con este adaptador. */
    streaming: boolean
    /** El adaptador permite seleccionar el modelo concreto. */
    modelSelection: boolean
  }
  /** Estado del endpoint: verificado en pruebas / por confirmar / planificado. */
  endpointStatus: 'verified' | 'needs_verification' | 'planned'
  note: string
  /** Rutas virtuales/reales servibles ahora mismo según configuración. */
  routableRoutes(): RoutableRoute[]
  /**
   * Rutas configuradas por administrador para modelos de catálogo concretos
   * (p. ej. 'groq:meta-llama/Llama-3.1-8B-Instruct'). Vacío si no hay config.
   */
  configuredCatalogRoutes(): RoutableRoute[]
  /** Ejecuta una petición de chat y normaliza la respuesta. Nunca simula éxito. */
  chat(options: AdapterChatOptions): Promise<NormalizedCompletion>
  /**
   * Streaming SSE verificado (opcional): emite incrementos y termina con el
   * resultado completo. Solo presente cuando capabilities.streaming es true.
   */
  chatStream?(options: AdapterChatOptions): AsyncGenerator<AdapterStreamEvent, AdapterStreamResult, void>
}

/** Decisión del enrutador. */
export interface RouteDecision {
  route: RoutableRoute
  fallbackUsed: boolean
  note: string
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly errorType: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
