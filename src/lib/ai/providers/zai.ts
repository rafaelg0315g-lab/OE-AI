/**
 * Adaptador del proveedor z-ai (Z.ai) — el proveedor DISPONIBLE en este entorno.
 *
 * VERIFICACIÓN REAL (sonda ejecutada durante la implementación):
 * - El SDK funciona y devuelve completions reales (prueba "PONG" superada).
 * - El parámetro `model` es IGNORADO por el SDK disponible: incluso con un nombre
 *   inválido responde OK y el campo `model` de la respuesta reporta el modelo
 *   predeterminado del proveedor (p. ej. 'glm-4-plus').
 * - Por tanto NO se puede verificar la conectividad de modelos individuales del
 *   catálogo a través de este adaptador, y NO se marcan como "Conectado".
 * - El streaming del SDK entrega líneas SSE crudas no documentadas e inestables:
 *   NO se anuncia soporte de streaming.
 */
import ZAI from 'z-ai-web-dev-sdk'
import { ProviderError, messageChars, type AdapterChatOptions, type AIProviderAdapter, type NormalizedCompletion, type RoutableRoute } from '../types'

export const ZAI_VIRTUAL_ROUTE_KEY = 'zai-org:default'

const VIRTUAL_LABEL =
  'OE AI LLM — modelo predeterminado del proveedor z-ai (sin selección de modelo)'

async function chatWithRetry(options: AdapterChatOptions, attempts = 3): Promise<NormalizedCompletion> {
  const started = Date.now()
  let lastError: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const zai = await ZAI.create()
      // Visión: si algún mensaje lleva partes image_url, se usa createVision
      // (contrato idéntico de respuesta; el núcleo analiza la imagen real).
      const hasImage = options.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
      )
      const completion = (await (hasImage
        ? zai.chat.completions.createVision({
            messages: options.messages,
            thinking: { type: 'disabled' },
          })
        : zai.chat.completions.create({
            messages: options.messages,
            thinking: { type: 'disabled' },
            // Nota: el SDK disponible ignora `model`; no se envía para no simular selección.
          } as never))) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
        model?: string
      }

      const content = completion.choices?.[0]?.message?.content ?? ''
      if (!content.trim()) {
        throw new ProviderError('El proveedor devolvió una respuesta vacía.', 'empty_response')
      }

      const text = content.slice(0, 24000)
      return {
        content: text,
        providerReportedModel: typeof completion.model === 'string' ? completion.model : null,
        latencyMs: Date.now() - started,
        promptChars: options.messages.reduce((acc, m) => acc + messageChars(m), 0),
        completionChars: text.length,
      }
    } catch (err) {
      lastError = err
      const isRateLimit = err instanceof Error && err.message.includes('429')
      const isAborted = options.signal?.aborted
      if (isAborted) {
        throw new ProviderError('Solicitud cancelada.', 'client_cancelled')
      }
      // Reintento solo para 429 (rate limit del proveedor), con backoff breve.
      if (isRateLimit && attempt < attempts) {
        await new Promise((r) => setTimeout(r, 900 * attempt))
        continue
      }
      break
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'Error desconocido del proveedor'
  // Mensaje seguro para el cliente: sin volcar cuerpos completos del proveedor.
  const safe = message.includes('429')
    ? 'El proveedor alcanzó su límite de peticiones (429). Espera unos segundos e inténtalo de nuevo.'
    : message.includes('timeout') || message.includes('TIMEOUT')
      ? 'El proveedor tardó demasiado en responder (timeout).'
      : 'El proveedor no pudo procesar la solicitud. No se generó ninguna respuesta simulada.'
  throw new ProviderError(safe, message.includes('429') ? 'provider_rate_limited' : 'provider_error')
}

export function createZaiAdapter(): AIProviderAdapter {
  return {
    id: 'zai-org',
    label: 'Z.ai (SDK de entorno OE)',
    envVarNames: ['(credenciales gestionadas por el entorno OE BUSINESS)'],
    isConfigured: () => true,
    capabilities: {
      chat: true,
      streaming: false, // No verificado de forma estable → no se anuncia
      modelSelection: false, // El SDK ignora `model` (verificado con sonda)
    },
    endpointStatus: 'verified',
    note:
      'Adaptador verificado con pruebas reales en este entorno. Sirve el modelo predeterminado configurado por el proveedor; NO permite seleccionar modelos concretos del catálogo, por lo que los modelos zai-org permanecen "No verificados" individualmente. Cada respuesta informa el modelo reportado por el proveedor.',
    routableRoutes(): RoutableRoute[] {
      return [
        {
          key: ZAI_VIRTUAL_ROUTE_KEY,
          providerId: 'zai-org',
          catalogModelId: null,
          providerModelId: 'default',
          label: VIRTUAL_LABEL,
          fromAdminConfig: false,
        },
      ]
    },
    configuredCatalogRoutes(): RoutableRoute[] {
      return [] // Sin selección de modelo, no hay rutas de catálogo configurables
    },
    chat: chatWithRetry,
  }
}
