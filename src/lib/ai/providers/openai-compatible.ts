/**
 * Adaptador genérico compatible con APIs estilo OpenAI.
 *
 * Sirve de plantilla REAL para proveedores externos (novita, cerebras, groq,
 * together, deepinfra, fireworks-ai, baseten, nscale, scaleway, cohere,
 * ovhcloud, publicai...). Cada proveedor define base URL, nombre de variable
 * de entorno y estado del endpoint. El adaptador SOLO se activa cuando existe
 * la credencial; mientras tanto, el proveedor aparece como "Disponible con
 * configuración" y sus rutas de catálogo como "No verificadas".
 *
 * ADVERTENCIAS:
 * - No se asume que todos los proveedores acepten exactamente los mismos
 *   parámetros: cada definición puede marcar el endpoint como
 *   'needs_verification' hasta completar una prueba real.
 * - Nunca se expone la clave ni se registra su valor.
 */
import {
  ProviderError,
  messageChars,
  type AdapterChatOptions,
  type AdapterStreamEvent,
  type AdapterStreamResult,
  type AIProviderAdapter,
  type NormalizedCompletion,
  type RoutableRoute,
} from '../types'
import type { EnabledModelRoute } from '../config'

export interface OpenAICompatibleProviderDef {
  id: string
  label: string
  /** URL base pública documentada por el proveedor (por confirmar en vigencia). */
  baseUrl: string | null
  envVarNames: string[]
  endpointStatus: 'verified' | 'needs_verification' | 'planned'
  note: string
  /** Streaming SSE verificado con pruebas reales para este proveedor. */
  streaming?: boolean
  /** Cabeceras adicionales exigidas/recomendadas por el proveedor (sin secretos). */
  extraHeaders?: Record<string, string>
}

export function createOpenAICompatibleAdapter(
  def: OpenAICompatibleProviderDef,
  enabledRoutes: EnabledModelRoute[],
): AIProviderAdapter {
  const getKey = (): string | undefined => {
    const name = def.envVarNames[0]
    const value = name ? process.env[name] : undefined
    return value && value.trim().length > 0 ? value.trim() : undefined
  }

  const configuredCatalogRoutes = (): RoutableRoute[] =>
    enabledRoutes
      .filter((r) => r.providerId === def.id)
      .map((r) => ({
        key: r.routeKey(),
        providerId: def.id,
        catalogModelId: r.modelId,
        providerModelId: r.providerModelId ?? r.modelId,
        label: `${r.modelId} vía ${def.label}`,
        fromAdminConfig: true,
      }))

  return {
    id: def.id,
    label: def.label,
    envVarNames: def.envVarNames,
    isConfigured: () => Boolean(getKey()) && Boolean(def.baseUrl),
    capabilities: {
      chat: true,
      streaming: Boolean(def.streaming), // Solo true cuando hubo verificación real del SSE
      modelSelection: true, // Las APIs estilo OpenAI reciben `model`
    },
    endpointStatus: def.endpointStatus,
    note: def.note,
    routableRoutes(): RoutableRoute[] {
      // Sin credenciales no hay rutas servibles; con credenciales, solo las
      // rutas de catálogo configuradas explícitamente por el administrador.
      return configuredCatalogRoutes().filter(() => this.isConfigured())
    },
    configuredCatalogRoutes,
    async chat(options: AdapterChatOptions): Promise<NormalizedCompletion> {
      const key = getKey()
      if (!key) {
        throw new ProviderError(
          `El proveedor ${def.label} no tiene credenciales configuradas (${def.envVarNames.join(', ')}).`,
          'provider_not_configured',
        )
      }
      if (!def.baseUrl) {
        throw new ProviderError(
          `El endpoint del proveedor ${def.label} aún no está definido en la configuración.`,
          'provider_endpoint_undefined',
        )
      }
      const started = Date.now()
      let response: Response
      try {
        response = await fetch(`${def.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            ...(def.extraHeaders ?? {}),
          },
          body: JSON.stringify({
            model: options.providerModelId,
            messages: options.messages,
            stream: false,
            // OpenRouter: excluye el razonamiento de los modelos reasoning
            // (nemotron…): evita que el 'thinking' se cuele en el contenido.
            // NVIDIA NIM: apaga el thinking de nemotron vía plantilla de chat;
            // sin esto el modelo devuelve content vacío (tokens quemados en
            // razonamiento interno). Los demás proveedores no reciben campos
            // extra (podrían rechazarlos).
            ...(def.id === 'openrouter' ? { reasoning: { exclude: true } } : {}),
            ...(def.id === 'nvidia' ? { chat_template_kwargs: { thinking: false } } : {}),
          }),
          signal: options.signal,
          cache: 'no-store',
        })
      } catch {
        throw new ProviderError(
          `No se pudo contactar con el proveedor ${def.label}. Comprueba conectividad y endpoint.`,
          'provider_unreachable',
        )
      }
      if (!response.ok) {
        throw httpErrorFor(def, response.status)
      }

      type OpenAIish = {
        choices?: Array<{ message?: { content?: string | null } }>
        model?: string
      }
      let data: OpenAIish
      try {
        data = (await response.json()) as OpenAIish
      } catch {
        throw new ProviderError(`La respuesta del proveedor ${def.label} no es JSON válido.`, 'provider_bad_payload')
      }
      const content = data.choices?.[0]?.message?.content ?? ''
      if (!content.trim()) {
        throw new ProviderError(`El proveedor ${def.label} devolvió una respuesta vacía.`, 'empty_response')
      }
      const text = content.slice(0, 24000)
      return {
        content: text,
        providerReportedModel: typeof data.model === 'string' ? data.model : null,
        latencyMs: Date.now() - started,
        promptChars: options.messages.reduce((acc, m) => acc + messageChars(m), 0),
        completionChars: text.length,
      }
    },
    // Streaming SSE (solo cuando el proveedor fue verificado con pruebas reales).
    ...(def.streaming
      ? {
          async *chatStream(options: AdapterChatOptions): AsyncGenerator<AdapterStreamEvent, AdapterStreamResult, void> {
            const key = getKey()
            if (!key || !def.baseUrl) {
              throw new ProviderError(
                `El proveedor ${def.label} no está configurado para streaming.`,
                'provider_not_configured',
              )
            }
            const started = Date.now()
            let response: Response
            try {
              response = await fetch(`${def.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${key}`,
                  ...(def.extraHeaders ?? {}),
                },
                body: JSON.stringify({
                  model: options.providerModelId,
                  messages: options.messages,
                  stream: true,
                  // Mismo motivo que en chat() (solo OpenRouter y NVIDIA).
                  ...(def.id === 'openrouter' ? { reasoning: { exclude: true } } : {}),
                  ...(def.id === 'nvidia' ? { chat_template_kwargs: { thinking: false } } : {}),
                }),
                signal: options.signal,
                cache: 'no-store',
              })
            } catch {
              throw new ProviderError(
                `No se pudo contactar con el proveedor ${def.label} (streaming).`,
                'provider_unreachable',
              )
            }
            if (!response.ok || !response.body) {
              throw httpErrorFor(def, response.status)
            }

            let reportedModel: string | null = null
            let accumulated = ''
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let sep: number
                while ((sep = buffer.indexOf('\n')) !== -1) {
                  const line = buffer.slice(0, sep).trim()
                  buffer = buffer.slice(sep + 1)
                  if (!line.startsWith('data:')) continue
                  const payload = line.slice(5).trim()
                  if (payload === '[DONE]') continue
                  try {
                    const json = JSON.parse(payload) as {
                      choices?: Array<{ delta?: { content?: string | null } }>
                      model?: string
                    }
                    if (!reportedModel && typeof json.model === 'string' && json.model) {
                      reportedModel = json.model
                    }
                    const delta = json.choices?.[0]?.delta?.content
                    if (typeof delta === 'string' && delta.length > 0) {
                      accumulated += delta
                      if (accumulated.length <= 24000) {
                        yield { delta }
                      }
                    }
                  } catch {
                    // Fragmento SSE malformado: se ignora de forma segura.
                  }
                }
              }
            } finally {
              reader.releaseLock()
            }
            if (!accumulated.trim()) {
              throw new ProviderError(
                `El proveedor ${def.label} no devolvió contenido en el stream.`,
                'empty_response',
              )
            }
            const content = accumulated.slice(0, 24000)
            return {
              content,
              providerReportedModel: reportedModel,
              latencyMs: Date.now() - started,
              promptChars: options.messages.reduce((acc, m) => acc + messageChars(m), 0),
              completionChars: content.length,
            }
          },
        }
      : {}),
  }
}

/** Mapea un estado HTTP del proveedor a un ProviderError informativo (sin secretos). */
function httpErrorFor(def: OpenAICompatibleProviderDef, status: number): ProviderError {
  if (status === 429) {
    return new ProviderError(
      `El proveedor ${def.label} alcanzó su límite de peticiones (429).`,
      'provider_rate_limited',
    )
  }
  if (status === 401 || status === 403) {
    return new ProviderError(
      `El proveedor ${def.label} rechazó las credenciales configuradas.`,
      'provider_auth_rejected',
    )
  }
  if (status === 404) {
    return new ProviderError(
      `El proveedor ${def.label} no reconoce el modelo solicitado (404). Verifica que la ruta apunte a un identificador vigente.`,
      'provider_model_unknown',
    )
  }
  return new ProviderError(
    `El proveedor ${def.label} respondió con el estado ${status}.`,
    'provider_http_error',
  )
}
