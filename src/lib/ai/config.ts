/**
 * Configuración de OE AI LLM mediante variables de entorno.
 * Nunca contiene valores secretos: solo lee nombres de variables.
 */
import { PRODUCT_CATEGORIES, type ProductCategory } from './types'

/** Ruta de modelo de catálogo habilitada por administrador vía OE_AI_MODEL_ROUTES. */
export interface EnabledModelRoute {
  providerId: string
  modelId: string // ID EXACTO del catálogo
  providerModelId?: string // si el proveedor usa otro identificador interno
  task?: ProductCategory
  routeKey(): string
}

function parseEnabledRoutes(raw: string | undefined): EnabledModelRoute[] {
  if (!raw) return []
  const out: EnabledModelRoute[] = []
  // Categorías válidas para el sufijo opcional (IMPORTANTE: los IDs de modelo de
  // OpenRouter terminan en ':free', que NO es una categoría y debe conservarse).
  const knownTasks: readonly string[] = PRODUCT_CATEGORIES
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    // Formato: proveedor:modeloCatalogo[>idInternoProveedor][:categoria]
    // El ID del modelo puede contener ':' (p. ej. 'nvidia/nemotron-3.5-lightning:free'),
    // así que el proveedor es todo lo anterior al PRIMER ':'. La categoría opcional
    // solo se reconoce si el sufijo tras el último ':' coincide con una conocida.
    const firstColon = trimmed.indexOf(':')
    if (firstColon <= 0) continue
    const providerId = trimmed.slice(0, firstColon).trim()
    let rest = trimmed.slice(firstColon + 1).trim()
    if (!providerId || !rest) continue
    let providerModelId: string | undefined
    let task: ProductCategory | undefined
    const lastColon = rest.lastIndexOf(':')
    if (lastColon !== -1) {
      const maybeTask = rest.slice(lastColon + 1).trim()
      if (knownTasks.includes(maybeTask)) {
        task = maybeTask as ProductCategory
        rest = rest.slice(0, lastColon).trim()
      }
    }
    const gtIndex = rest.indexOf('>')
    if (gtIndex !== -1) {
      providerModelId = rest.slice(gtIndex + 1).trim() || undefined
      rest = rest.slice(0, gtIndex).trim()
    }
    if (!rest) continue
    out.push({
      providerId,
      modelId: rest,
      providerModelId,
      task,
      routeKey() {
        return `${this.providerId}:${this.providerModelId ?? this.modelId}`
      },
    })
  }
  return out
}

/** Rutas habilitadas: OE_AI_MODEL_ROUTES="groq:meta-llama/Llama-3.1-8B-Instruct, openrouter:nvidia/nemotron-3.5-lightning:free" */
export const ENABLED_MODEL_ROUTES: EnabledModelRoute[] = parseEnabledRoutes(
  process.env.OE_AI_MODEL_ROUTES,
)

export const ROUTER_CONFIG = {
  /** 'auto' | 'manual_only' */
  mode: (process.env.AI_ROUTER_MODE as 'auto' | 'manual_only' | undefined) ?? 'auto',
  defaultProvider: process.env.AI_DEFAULT_PROVIDER ?? null,
  defaultModel: process.env.AI_DEFAULT_MODEL ?? null,
  /** Fallback al modelo predeterminado del proveedor cuando falla una ruta configurada. */
  fallbackAllowed: (process.env.AI_FALLBACK_ALLOWED ?? 'true') !== 'false',
  /** Límites de protección (configurables). */
  maxDailyRequests: Number(process.env.AI_MAX_DAILY_REQUESTS ?? 2000),
  chatRequestsPerMinute: Number(process.env.AI_CHAT_RPM ?? 12),
  apiRequestsPerMinute: Number(process.env.AI_API_RPM ?? 30),
  maxMessageChars: Number(process.env.AI_MAX_MESSAGE_CHARS ?? 8000),
  maxHistoryMessages: Number(process.env.AI_MAX_HISTORY ?? 16),
}

export const ADMIN_TOKEN_SET = Boolean(process.env.OE_AI_ADMIN_TOKEN && process.env.OE_AI_ADMIN_TOKEN.length > 0)
export const PUBLIC_API_KEY_SET = Boolean(process.env.OE_AI_API_KEY && process.env.OE_AI_API_KEY.length > 0)

export function isAdminTokenValid(token: string | null | undefined): boolean {
  const expected = process.env.OE_AI_ADMIN_TOKEN
  if (!expected || !token) return false
  // Comparación de tiempo constante básica para evitar trivialidades.
  if (token.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i)
  return diff === 0
}

export function isPublicApiKeyValid(key: string | null | undefined): boolean {
  const expected = process.env.OE_AI_API_KEY
  if (!expected || !key) return false
  if (key.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ key.charCodeAt(i)
  return diff === 0
}
