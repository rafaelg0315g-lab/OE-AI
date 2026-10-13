/**
 * Adaptador del proveedor z-ai (Z.ai) — el proveedor DISPONIBLE en este entorno.
 *
 * VERIFICACIÓN REAL (sondas ejecutadas):
 * - El SDK funciona y devuelve completions reales (prueba "PONG" superada).
 * - El parámetro `model` es IGNORADO por el SDK disponible: incluso con un nombre
 *   inválido responde OK y el campo `model` de la respuesta reporta el modelo
 *   predeterminado del proveedor (p. ej. 'glm-4-plus').
 * - STREAMING VERIFICADO (Task 41): `create({ stream: true })` devuelve un
 *   iterable de Uint8Array con líneas SSE estándar OpenAI-style
 *   (data: {"choices":[{"delta":{"content":"…"}}]} … data: [DONE]).
 *   Primer token ~0.7s; respuesta de 17k chars en 46s; 38k chars (8.9k tokens)
 *   en 100s con `max_tokens: 16384` → el techo por defecto (~4096 tokens de
 *   salida) SE LEVANTA pasando ese parámetro.
 * - La visión (createVision) no tiene streaming verificado: los turnos con
 *   imagen siguen la ruta única (chat) vía fallback del runtime.
 */
import ZAI from 'z-ai-web-dev-sdk'
import {
  ProviderError,
  messageChars,
  type AdapterChatOptions,
  type AdapterStreamEvent,
  type AIProviderAdapter,
  type NormalizedCompletion,
  type RoutableRoute,
} from '../types'
import { MAX_ASSISTANT_CONTENT_CHARS } from '../types-helpers'

export const ZAI_VIRTUAL_ROUTE_KEY = 'zai-org:default'

const VIRTUAL_LABEL =
  'OE AI LLM — modelo predeterminado del proveedor z-ai (sin selección de modelo)'

/** Techo de salida pedido al proveedor: 16k tokens ≈ 64KB de código/texto. */
const MAX_OUTPUT_TOKENS = 16_384

/** El turno pide visión (algún mensaje lleva partes image_url). */
function hasImageParts(messages: AdapterChatOptions['messages']): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))
}

/** Evento parseado del stream crudo del SDK: delta de texto y/o modelo reportado. */
interface ZaiStreamItem {
  delta?: string
  model?: string
}

/** Parser del stream crudo del SDK: Uint8Array → líneas SSE → deltas + modelo. */
async function* streamZaiChunks(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<ZaiStreamItem, void, void> {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += Buffer.from(chunk).toString('utf8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload) as {
          model?: string
          choices?: Array<{ delta?: { content?: string | null } }>
        }
        const item: ZaiStreamItem = {}
        if (typeof json.model === 'string' && json.model) item.model = json.model
        const delta = json.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) item.delta = delta
        if (item.delta || item.model) yield item
      } catch {
        // Línea SSE no JSON (comentario/ping del proveedor): ignorar.
      }
    }
  }
}

/** Wrapper del SDK con reintentos 429 para la ruta única (sin streaming). */
async function chatWithRetry(options: AdapterChatOptions, attempts = 3): Promise<NormalizedCompletion> {
  const started = Date.now()
  let lastError: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const zai = await ZAI.create()
      // Visión: si algún mensaje lleva partes image_url, se usa createVision
      // (contrato idéntico de respuesta; el núcleo analiza la imagen real).
      const completion = (await (hasImageParts(options.messages)
        ? zai.chat.completions.createVision({
            messages: options.messages,
            thinking: { type: 'disabled' },
          })
        : zai.chat.completions.create({
            messages: options.messages,
            thinking: { type: 'disabled' },
            max_tokens: MAX_OUTPUT_TOKENS, // levanta el techo ~4096 → 16384 (verificado)
            // Nota: el SDK disponible ignora `model`; no se envía para no simular selección.
          } as never))) as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
        model?: string
      }

      const content = (completion.choices?.[0]?.message?.content ?? '').slice(0, MAX_ASSISTANT_CONTENT_CHARS)
      if (!content.trim()) {
        throw new ProviderError('El proveedor devolvió una respuesta vacía.', 'empty_response')
      }

      return {
        content,
        providerReportedModel: typeof completion.model === 'string' ? completion.model : null,
        latencyMs: Date.now() - started,
        promptChars: options.messages.reduce((acc, m) => acc + messageChars(m), 0),
        completionChars: content.length,
      }
    } catch (err) {
      lastError = err
      if (err instanceof ProviderError) throw err
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
      streaming: true, // VERIFICADO Task 41: SSE crudo Uint8Array → parser propio
      modelSelection: false, // El SDK ignora `model` (verificado con sonda)
    },
    endpointStatus: 'verified',
    note:
      'Adaptador verificado con pruebas reales en este entorno. Sirve el modelo predeterminado configurado por el proveedor; NO permite seleccionar modelos concretos del catálogo, por lo que los modelos zai-org permanecen "No verificados" individualmente. Cada respuesta informa el modelo reportado por el proveedor. Streaming real verificado (deltas incrementales, max_tokens 16384).',
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
    async *chatStream(options: AdapterChatOptions): AsyncGenerator<AdapterStreamEvent, NormalizedCompletion, void> {
      const started = Date.now()
      // La visión no tiene streaming verificado: error ANTES de emitir contenido
      // para que el runtime haga fallback a la ruta única (chat → createVision).
      if (hasImageParts(options.messages)) {
        throw new ProviderError('La visión no soporta streaming en este proveedor.', 'provider_stream_unsupported')
      }
      let zai: Awaited<ReturnType<typeof ZAI.create>>
      try {
        zai = await ZAI.create()
      } catch (err) {
        if (options.signal?.aborted) throw new ProviderError('Solicitud cancelada.', 'client_cancelled')
        throw new ProviderError(
          `No se pudo contactar con el proveedor z-ai (streaming): ${err instanceof Error ? err.message.slice(0, 120) : 'error desconocido'}.`,
          'provider_unreachable',
        )
      }

      let stream: AsyncIterable<Uint8Array>
      try {
        stream = (await zai.chat.completions.create({
          messages: options.messages,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
          thinking: { type: 'disabled' },
        } as never)) as AsyncIterable<Uint8Array>
      } catch (err) {
        if (options.signal?.aborted) throw new ProviderError('Solicitud cancelada.', 'client_cancelled')
        const message = err instanceof Error ? err.message : 'error desconocido'
        const safe = message.includes('429')
          ? 'El proveedor alcanzó su límite de peticiones (429).'
          : 'No se pudo iniciar el streaming del proveedor z-ai.'
        throw new ProviderError(safe, message.includes('429') ? 'provider_rate_limited' : 'provider_error')
      }

      let accumulated = ''
      let reportedModel: string | null = null
      try {
        for await (const item of streamZaiChunks(stream)) {
          if (options.signal?.aborted) {
            throw new ProviderError('Solicitud cancelada.', 'client_cancelled')
          }
          if (item.model && !reportedModel) reportedModel = item.model
          if (item.delta) {
            accumulated += item.delta
            yield { delta: item.delta }
          }
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err
        if (options.signal?.aborted) throw new ProviderError('Solicitud cancelada.', 'client_cancelled')
        // Fallo a mitad del stream: sin fallback posible (ya hay contenido
        // emitido) → error claro; el cliente conserva el texto parcial.
        const message = err instanceof Error ? err.message : 'stream interrumpido'
        throw new ProviderError(
          message.includes('429')
            ? 'El proveedor interrumpió el stream por límite de peticiones (429).'
            : 'El streaming del proveedor se interrumpió antes de terminar.',
          message.includes('429') ? 'provider_rate_limited' : 'provider_stream_interrupted',
        )
      }

      if (!accumulated.trim()) {
        throw new ProviderError('El proveedor devolvió una respuesta vacía.', 'empty_response')
      }
      // El modelo reportado llega dentro de los chunks (campo `model`, primer
      // chunk); el parser lo captura en reportedModel.
      const content = accumulated.slice(0, MAX_ASSISTANT_CONTENT_CHARS)
      return {
        content,
        providerReportedModel: reportedModel,
        latencyMs: Date.now() - started,
        promptChars: options.messages.reduce((acc, m) => acc + messageChars(m), 0),
        completionChars: content.length,
      }
    },
  }
}
