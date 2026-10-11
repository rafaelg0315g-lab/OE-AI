/**
 * Cliente LLM del Constructor de Apps (servidor únicamente).
 *
 * Estrategia en cascada real según proveedores de código del propietario:
 *   1) GOOGLE GEMINI (GEMINI_API_KEY) — doble ruta automática:
 *      a) Vertex AI express (aiplatform.googleapis.com, sin bloqueo geo)
 *      b) AI Studio directo (generativelanguage.googleapis.com, requiere
 *         región soportada)
 *   2) GROQ (GROQ_API_KEY) — API compatible OpenAI (api.groq.com).
 *   3) Núcleo z-ai (reintentos ante 429).
 *   4) OpenRouter (modelo rápido verificado).
 * Cada proveedor falla RÁPIDO y sin reintentos inútiles si su región/clave no
 * está disponible, cediendo el turno al siguiente eslabón.
 * - Extracción robusta de JSON (los modelos suelen envolver la respuesta).
 * - Sin registro del contenido de prompts/respuestas en logs del servidor.
 */
import ZAI from 'z-ai-web-dev-sdk'
import type { ChatRequestMessage } from '@/lib/ai/types'

export class BuildLlmError extends Error {
  errorType: 'rate_limited' | 'empty_response' | 'json_parse' | 'provider_error' | 'aborted'

  constructor(message: string, errorType: BuildLlmError['errorType']) {
    super(message)
    this.errorType = errorType
  }
}

const RETRY_DELAYS_MS = [1500, 4000, 8000]
/** Modelo rápido verificado en sondas reales (PONG 279-299 ms). */
const OPENROUTER_BUILD_MODEL = 'openai/gpt-oss-20b'
const OPENROUTER_TIMEOUT_MS = 180_000

/** Proveedor de código Google Gemini (configurable por .env). */
const GEMINI_MODEL = process.env.GEMINI_BUILD_MODEL || 'gemini-3.1-pro-preview'
const GEMINI_TIMEOUT_MS = 180_000

/** Proveedor de código Groq (configurable por .env). */
const GROQ_MODEL = process.env.GROQ_BUILD_MODEL || 'openai/gpt-oss-120b'
const GROQ_TIMEOUT_MS = 180_000

export type BuildCore = `gemini/${string}` | `groq/${string}` | 'openrouter/gpt-oss-20b' | 'zai-org:default'

export type CorePreference = 'zai' | 'openrouter'

interface CoreCallResult {
  content: string
  core: BuildCore
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> }
  finishReason?: string
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  promptFeedback?: { blockReason?: string }
  error?: { code?: number; message?: string; status?: string }
}

/**
 * Llamada a Google Gemini con doble ruta automática:
 *  a) Vertex AI express con la clave (aiplatform, sin bloqueo geográfico;
 *     exige que el propietario habilite la API "Vertex AI API" en su proyecto).
 *  b) AI Studio directo (generativelanguage; solo desde regiones soportadas).
 * Devuelve el primer resultado exitoso; si ambas rutas fallan lanza BuildLlmError
 * y la cascada continúa con el siguiente núcleo.
 */
async function geminiChat(messages: ChatRequestMessage[], signal?: AbortSignal): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new BuildLlmError('GEMINI_API_KEY no configurada.', 'provider_error')

  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))

  // gemini-2.5-pro exige thinkingBudget mínimo 128; flash admite 0 (más rápido).
  const thinkingBudget = GEMINI_MODEL.includes('flash') ? 0 : 512
  const body: Record<string, unknown> = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 32_768,
      ...(GEMINI_MODEL.includes('2.5') ? { thinkingConfig: { thinkingBudget } } : {}),
    },
  }

  const endpoints = [
    {
      url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      label: 'vertex-express',
    },
    {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      label: 'ai-studio',
      headers: { 'x-goog-api-key': key },
    },
  ]

  let lastDetail = 'sin detalle'
  for (const ep of endpoints) {
    let data: GeminiResponse | null = null
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...('headers' in ep ? ep.headers : {}) },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      })
      if (res.status === 429) {
        // 429 de Gemini (cuota free-tier "limit: 0" o límite por minuto): no se
        // reintenta — la construcción continúa con el siguiente núcleo al
        // instante, sin demoras de backoff.
        data = (await res.json().catch(() => null)) as GeminiResponse | null
        const quotaText = JSON.stringify(data ?? {}).slice(0, 500)
        lastDetail = /limit['"]?\s*[:=]\s*['"]?0\b/.test(quotaText)
          ? 'cuota del modelo = 0 (requiere facturación habilitada en el proyecto Google)'
          : '429 de cuota (free tier) en Gemini'
        continue
      }
      data = (await res.json().catch(() => null)) as GeminiResponse | null
      if (!res.ok) {
        lastDetail = data?.error?.message?.slice(0, 160) || `HTTP ${res.status}`
        // 400 FAILED_PRECONDITION (región no soportada) o 403 SERVICE_DISABLED:
        // la ruta no está disponible → probar la siguiente sin reintentar.
        continue
      }
      const block = data?.promptFeedback?.blockReason
      if (block) {
        lastDetail = `bloqueado por ${block}`
        continue
      }
      const text = (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim()
      if (!text) {
        lastDetail = `respuesta vacía (${data?.candidates?.[0]?.finishReason ?? 'sin candidato'})`
        continue
      }
      return text
    } catch (err) {
      if (signal?.aborted) throw new BuildLlmError('Ejecución cancelada.', 'aborted')
      if (err instanceof BuildLlmError) throw err // rate_limited / aborted: no cambiar de ruta
      lastDetail = err instanceof Error ? err.message.slice(0, 160) : 'error de red'
    }
  }
  console.error(`[build:llm] Gemini no disponible (${lastDetail}); continuando la cascada con el siguiente núcleo`)
  throw new BuildLlmError(`Gemini no disponible: ${lastDetail}`, 'provider_error')
}

/**
 * Llamada a Groq (API compatible OpenAI, api.groq.com) con la clave del
 * propietario. Si Groq bloquea la región del servidor responde 403 Forbidden
 * (incluso sin clave): se detecta y cede el turno al siguiente núcleo sin
 * reintentos, porque es un bloqueo persistente de IP y no de la clave.
 */
async function groqChat(messages: ChatRequestMessage[], signal?: AbortSignal): Promise<string> {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new BuildLlmError('GROQ_API_KEY no configurada.', 'provider_error')
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 32_768,
      temperature: 0.6,
    }),
    signal: signal ?? AbortSignal.timeout(GROQ_TIMEOUT_MS),
  })
  if (res.status === 403) {
    // Bloqueo regional/persistente de Groq (aplica incluso sin clave).
    console.error('[build:llm] Groq no disponible desde esta región (403 Forbidden); continuando la cascada')
    throw new BuildLlmError('Groq no disponible desde esta región (403).', 'provider_error')
  }
  if (res.status === 429) throw new BuildLlmError('429', 'rate_limited')
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new BuildLlmError(`Groq HTTP ${res.status}: ${detail.slice(0, 160)}`, 'provider_error')
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) throw new BuildLlmError('Respuesta vacía de Groq.', 'empty_response')
  return content
}

/** Llamada directa a OpenRouter (clave solo en servidor). */
async function openRouterChat(messages: ChatRequestMessage[], signal?: AbortSignal): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new BuildLlmError('OPENROUTER_API_KEY no configurada.', 'provider_error')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://oe-ai.local',
      'X-Title': 'OE AI Builder',
    },
    body: JSON.stringify({
      model: OPENROUTER_BUILD_MODEL,
      messages,
      max_tokens: 16_384,
    }),
    signal: signal ?? AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  })
  if (res.status === 429) throw new BuildLlmError('429', 'rate_limited')
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new BuildLlmError(`OpenRouter HTTP ${res.status}: ${detail.slice(0, 160)}`, 'provider_error')
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) throw new BuildLlmError('Respuesta vacía de OpenRouter.', 'empty_response')
  return content
}

/** Llamada al núcleo z-ai (proveedor conectado por defecto). */
async function zaiCoreChat(messages: ChatRequestMessage[], signal?: AbortSignal): Promise<string> {
  const zai = await ZAI.create()
  const completion = (await zai.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
    // Salidas grandes (proyectos completos): el límite por defecto truncaba
    // el JSON a mitad de archivo. 16k cubre ~700 líneas de código con holgura.
    max_tokens: 16_384,
  } as never)) as {
    choices?: Array<{ message?: { content?: string | null } }>
  }
  const content = completion.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) throw new BuildLlmError('El núcleo devolvió una respuesta vacía.', 'empty_response')
  return content
}

/**
 * Llamada de texto con estrategia en cascada real según preferencia:
 * - Gemini y Groq (si sus claves existen) SIEMPRE primero: proveedores de
 *   código del propietario; si no están disponibles (región, cuota o API
 *   deshabilitada) fallan rápido y la cascada continúa sin interrumpir.
 * - 'zai' (defecto tras los proveedores del propietario): 1) Núcleo z-ai con
 *   reintentos 429 → 2) OpenRouter como respaldo.
 * - 'openrouter': 1) OpenRouter → 2) Núcleo z-ai.
 */
export async function buildChatWithCore(
  messages: ChatRequestMessage[],
  signal?: AbortSignal,
  prefer: CorePreference = 'zai',
): Promise<CoreCallResult> {
  const rest: Array<'zai' | 'openrouter'> =
    prefer === 'openrouter' ? ['openrouter', 'zai'] : ['zai', 'openrouter']
  const owner: Array<'gemini' | 'groq'> = [
    ...(process.env.GEMINI_API_KEY ? (['gemini'] as const) : []),
    ...(process.env.GROQ_API_KEY ? (['groq'] as const) : []),
  ]
  const order: Array<'gemini' | 'groq' | 'zai' | 'openrouter'> = [...owner, ...rest]
  let lastError: unknown = null

  for (const target of order) {
    if (target === 'openrouter' && !process.env.OPENROUTER_API_KEY) continue
    if (target === 'gemini' && !process.env.GEMINI_API_KEY) continue
    if (target === 'groq' && !process.env.GROQ_API_KEY) continue
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (signal?.aborted) throw new BuildLlmError('Ejecución cancelada.', 'aborted')
      try {
        const content =
          target === 'openrouter'
            ? await openRouterChat(messages, signal)
            : target === 'gemini'
              ? await geminiChat(messages, signal)
              : target === 'groq'
                ? await groqChat(messages, signal)
                : await zaiCoreChat(messages, signal)
        return {
          content,
          core:
            target === 'openrouter'
              ? 'openrouter/gpt-oss-20b'
              : target === 'gemini'
                ? (`gemini/${GEMINI_MODEL}` as BuildCore)
                : target === 'groq'
                  ? (`groq/${GROQ_MODEL}` as BuildCore)
                  : 'zai-org:default',
        }
      } catch (err) {
        if (signal?.aborted) throw new BuildLlmError('Ejecución cancelada.', 'aborted')
        if (err instanceof BuildLlmError && err.errorType === 'aborted') throw err
        lastError = err
        const isRate = err instanceof Error && err.message.includes('429')
        const isLast = attempt === RETRY_DELAYS_MS.length
        if (isRate && !isLast) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
          continue
        }
        break
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'Error desconocido del núcleo'
  if (message.includes('429')) {
    throw new BuildLlmError(
      'Los núcleos alcanzaron su límite de peticiones (429). Espera unos segundos e inténtalo de nuevo.',
      'rate_limited',
    )
  }
  throw new BuildLlmError(
    'El constructor no pudo completar el paso con ningún núcleo configurado. No se generó nada simulado.',
    'provider_error',
  )
}

/** Extrae el primer objeto JSON balanceado de una respuesta de modelo. */
export function extractJsonObject(raw: string): Record<string, unknown> {
  let text = raw.trim()
  // Quita vallas de código ```json ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) text = fence[1].trim()

  const start = text.indexOf('{')
  if (start === -1) throw new BuildLlmError('La respuesta no contiene JSON.', 'json_parse')

  // Balanceo de llaves respetando cadenas y escapes.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        try {
          return JSON.parse(candidate) as Record<string, unknown>
        } catch {
          throw new BuildLlmError('El JSON del constructor no pudo parsearse.', 'json_parse')
        }
      }
    }
  }
  throw new BuildLlmError('El JSON del constructor está incompleto.', 'json_parse')
}

/** Llamada que exige JSON; reintenta una vez con mensaje de reparación. */
export async function buildChatJson<T>(
  system: string,
  user: string,
  signal?: AbortSignal,
  prefer: CorePreference = 'zai',
): Promise<{ data: T; core: BuildCore }> {
  const messages: ChatRequestMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]

  for (let attempt = 0; attempt < 2; attempt++) {
    const { content: raw, core } = await buildChatWithCore(messages, signal, prefer)
    try {
      return { data: extractJsonObject(raw) as T, core }
    } catch {
      if (attempt === 0) {
        messages.push({ role: 'assistant', content: raw.slice(0, 2000) })
        messages.push({
          role: 'user',
          content:
            'Tu respuesta anterior no era JSON válido. Responde ÚNICAMENTE con el objeto JSON solicitado, sin texto adicional ni vallas de código.',
        })
        continue
      }
      throw new BuildLlmError('El constructor no produjo JSON válido tras reintentarlo.', 'json_parse')
    }
  }
  // Inalcanzable (el bucle siempre retorna o lanza).
  throw new BuildLlmError('Error interno del constructor.', 'provider_error')
}
