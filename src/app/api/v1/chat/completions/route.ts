import { z } from 'zod'
import { isPublicApiKeyValid, PUBLIC_API_KEY_SET, ROUTER_CONFIG } from '@/lib/ai/config'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { resolveRoute, parseSelection, RouterError, type ModelSelection } from '@/lib/ai/router'
import { providerRegistry } from '@/lib/ai/providers'
import { recordUsage, countRequestsSince } from '@/lib/ai/usage'
import { latestChecks } from '@/lib/ai/health'
import { ProviderError } from '@/lib/ai/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CompletionsSchema = z.object({
  model: z.string().max(200).optional().default('auto'),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1).max(ROUTER_CONFIG.maxMessageChars),
      }),
    )
    .min(1)
    .max(40),
  stream: z.boolean().optional().default(false),
  allow_fallback: z.boolean().optional().default(false),
})

function apiError(status: number, code: string, message: string, requestId: string, extraHeaders?: Record<string, string>) {
  return Response.json(
    { error: { code, message }, requestId, object: 'oe_ai.error' },
    { status, headers: { 'X-Request-Id': requestId, ...extraHeaders } },
  )
}

/**
 * POST /api/v1/chat/completions — API pública de OE AI (no streaming).
 *
 * Estados HTTP: 200 ok · 400 validación · 401 clave inválida · 404 ruta/modelo
 * no configurado · 429 límites · 502 fallo del proveedor (sin respuesta simulada) ·
 * 503 API no habilitada.
 * Requiere OE_AI_API_KEY en el servidor (header Authorization: Bearer).
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  if (!PUBLIC_API_KEY_SET) {
    return apiError(
      503,
      'api_not_enabled',
      'La API pública de OE AI no está habilitada en este entorno. Configura OE_AI_API_KEY en el servidor para activarla. El catálogo de /apis funciona de forma informativa con independencia de la API.',
      requestId,
    )
  }

  const auth = request.headers.get('authorization') ?? ''
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
  if (!isPublicApiKeyValid(key)) {
    return apiError(401, 'invalid_api_key', 'Clave de API ausente o inválida.', requestId)
  }

  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'api'), ROUTER_CONFIG.apiRequestsPerMinute, 60_000)
  if (!rl.allowed) {
    return apiError(429, 'rate_limited', `Límite de ${ROUTER_CONFIG.apiRequestsPerMinute} peticiones por minuto superado.`, requestId, {
      'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
    })
  }

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  if ((await countRequestsSince(startOfDay)) >= ROUTER_CONFIG.maxDailyRequests) {
    return apiError(429, 'daily_limit_reached', 'Se alcanzó el límite diario de solicitudes.', requestId)
  }

  let body: z.infer<typeof CompletionsSchema>
  try {
    body = CompletionsSchema.parse(await request.json())
  } catch {
    return apiError(400, 'invalid_payload', 'Payload inválido según el esquema de /api/v1/chat/completions.', requestId)
  }

  const selection: ModelSelection = parseSelection(body.model)
  let decision
  try {
    let verifiedRouteKeys: Set<string> | undefined
    if (selection.kind === 'auto') {
      try {
        const checks = await latestChecks()
        verifiedRouteKeys = new Set(
          providerRegistry
            .availableRoutes()
            .filter((r) => r.catalogModelId && checks.get(`model:${r.catalogModelId}`)?.status === 'ok')
            .map((r) => r.key),
        )
        if (verifiedRouteKeys.size === 0) verifiedRouteKeys = undefined
      } catch {
        verifiedRouteKeys = undefined
      }
    }
    decision = resolveRoute(selection, undefined, body.allow_fallback, verifiedRouteKeys)
  } catch (err) {
    if (err instanceof RouterError) {
      const status = err.errorType === 'unknown_model' || err.errorType === 'route_not_configured' ? 404 : 503
      return apiError(status, err.errorType, err.message, requestId)
    }
    return apiError(503, 'route_error', 'No se pudo resolver la ruta del modelo.', requestId)
  }

  const adapter = providerRegistry.get(decision.route.providerId)
  if (!adapter) {
    return apiError(503, 'adapter_missing', 'Adaptador de proveedor no disponible.', requestId)
  }

  // Streaming: solo con proveedores verificados (SSE real). Para el resto se
  // mantiene la negación honesta en lugar de simular chunks.
  const wantsStream = body.stream && adapter.capabilities.streaming && typeof adapter.chatStream === 'function'
  if (body.stream && !wantsStream) {
    return apiError(
      400,
      'streaming_not_supported',
      `El proveedor resuelto (${adapter.label}) no tiene streaming verificado en este entorno; envía "stream": false.`,
      requestId,
    )
  }

  try {
    if (wantsStream && adapter.chatStream) {
      // SSE compatible con clientes estilo OpenAI: chunks delta + [DONE].
      const encoder = new TextEncoder()
      const abortController = new AbortController()
      request.signal.addEventListener('abort', () => abortController.abort())
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (payload: unknown) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
            } catch {
              // cliente desconectado
            }
          }
          try {
            const iter = adapter.chatStream!({
              messages: body.messages,
              providerModelId: decision.route.providerModelId,
              signal: abortController.signal,
            })
            while (true) {
              const { value, done } = await iter.next()
              if (done) {
                await recordUsage({
                  requestId,
                  source: 'api_v1',
                  providerId: decision.route.providerId,
                  requestedModelId: body.model,
                  resolvedModelId: decision.route.catalogModelId ?? decision.route.key,
                  providerReportedModel: value.providerReportedModel,
                  status: 'ok',
                  latencyMs: value.latencyMs,
                  promptChars: value.promptChars,
                  completionChars: value.completionChars,
                  fallbackUsed: decision.fallbackUsed,
                })
                send({
                  id: requestId,
                  object: 'oe_ai.chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: value.providerReportedModel ?? decision.route.label,
                  oe_ai: { provider_id: decision.route.providerId, catalog_model_id: decision.route.catalogModelId, note: decision.note },
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                })
                break
              }
              send({
                id: requestId,
                object: 'oe_ai.chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: decision.route.label,
                choices: [{ index: 0, delta: { content: value.delta }, finish_reason: null }],
              })
            }
          } catch (err) {
            if (!abortController.signal.aborted) {
              const errorType = err instanceof ProviderError ? err.errorType : 'provider_error'
              const message = err instanceof ProviderError ? err.message : 'El proveedor no pudo completar la solicitud.'
              await recordUsage({
                requestId,
                source: 'api_v1',
                providerId: decision.route.providerId,
                requestedModelId: body.model,
                resolvedModelId: decision.route.catalogModelId ?? decision.route.key,
                status: 'error',
                errorType,
                fallbackUsed: decision.fallbackUsed,
              })
              send({ error: { code: errorType, message }, requestId, object: 'oe_ai.error' })
            }
          } finally {
            try {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            } catch {
              // cliente desconectado
            }
            controller.close()
          }
        },
        cancel() {
          abortController.abort()
        },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Request-Id': requestId,
        },
      })
    }

    const completion = await adapter.chat({ messages: body.messages, providerModelId: decision.route.providerModelId })
    await recordUsage({
      requestId,
      source: 'api_v1',
      providerId: decision.route.providerId,
      requestedModelId: body.model,
      resolvedModelId: decision.route.catalogModelId ?? decision.route.key,
      providerReportedModel: completion.providerReportedModel,
      status: 'ok',
      latencyMs: completion.latencyMs,
      promptChars: completion.promptChars,
      completionChars: completion.completionChars,
      fallbackUsed: decision.fallbackUsed,
    })

    return Response.json(
      {
        id: requestId,
        object: 'oe_ai.chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: completion.providerReportedModel ?? decision.route.label,
        oe_ai: {
          provider_id: decision.route.providerId,
          catalog_model_id: decision.route.catalogModelId,
          route_key: decision.route.key,
          fallback_used: decision.fallbackUsed,
          note: decision.note,
        },
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: completion.content },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_chars: completion.promptChars,
          completion_chars: completion.completionChars,
        },
      },
      { headers: { 'X-Request-Id': requestId, 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    const errorType = err instanceof ProviderError ? err.errorType : 'provider_error'
    const message = err instanceof ProviderError ? err.message : 'El proveedor no pudo completar la solicitud.'
    await recordUsage({
      requestId,
      source: 'api_v1',
      providerId: decision.route.providerId,
      requestedModelId: body.model,
      resolvedModelId: decision.route.catalogModelId ?? decision.route.key,
      status: 'error',
      errorType,
      fallbackUsed: decision.fallbackUsed,
    })
    const status =
      errorType === 'provider_rate_limited'
        ? 429
        : errorType === 'provider_not_configured' || errorType === 'provider_endpoint_undefined'
          ? 503
          : 502
    return apiError(status, errorType, message, requestId)
  }
}
