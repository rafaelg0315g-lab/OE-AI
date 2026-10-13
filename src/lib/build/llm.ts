/**
 * Cliente LLM del Constructor de Apps (servidor únicamente).
 *
 * Estrategia en DOS fases (carrera + respaldo) para máxima velocidad:
 *   FASE 1 — CARRERA PARALELA (gana el primero en terminar, como la cascada
 *   de imágenes): NVIDIA NIM (IAs de código abierto, nemotron-3-super 120B
 *   con thinking OFF: ~25 s por archivo grande), OpenRouter (modelo free
 *   verificado) y núcleo z-ai. Si un proveedor está sin cuota (429) simplemente
 *   pierde la carrera; nadie bloquea a los demás.
 *   FASE 2 — RESPALDOS SECUENCIALES (solo si TODA la carrera falló):
 *   Google Gemini (doble ruta vertex/ai-studio) → Groq.
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

/** Modelo FREE verificado con prueba real (JSON limpio, sin reasoning). */
const OPENROUTER_BUILD_MODEL =
  process.env.OPENROUTER_BUILD_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free'
const OPENROUTER_TIMEOUT_MS = 150_000

/**
 * NVIDIA NIM (integrate.api.nvidia.com) — IAs de código abierto gratis.
 * nemotron-3-super-120b-a12b con thinking OFF generó 7.5 KB de JSON de código
 * real en ~25 s (prueba E2E); los 16k tokens sin thinking:false se quemaban
 * en razonamiento interno (content vacío).
 */
const NVIDIA_MODEL = process.env.NVIDIA_BUILD_MODEL || 'nvidia/nemotron-3-super-120b-a12b'
const NVIDIA_TIMEOUT_MS = 150_000

/** Proveedor de código Google Gemini (configurable por .env). */
const GEMINI_MODEL = process.env.GEMINI_BUILD_MODEL || 'gemini-3.1-pro-preview'
const GEMINI_TIMEOUT_MS = 180_000

/** Proveedor de código Groq (configurable por .env). */
const GROQ_MODEL = process.env.GROQ_BUILD_MODEL || 'openai/gpt-oss-120b'
const GROQ_TIMEOUT_MS = 180_000

export type BuildCore =
  | `gemini/${string}`
  | `groq/${string}`
  | `nvidia/${string}`
  | `openrouter/${string}`
  | 'zai-org:default'

export type CorePreference = 'zai' | 'openrouter'

interface CoreCallResult {
  content: string
  core: BuildCore
}

/** Miembro de la carrera: un proveedor con un solo intento (falla rápido). */
interface Racer {
  id: string
  core: BuildCore
  run: () => Promise<string>
}

/**
 * Carrera paralela de generadores: resuelve con el PRIMER resultado exitoso y
 * rechaza solo si TODOS fallan (AggregateError con los errores individuales).
 * Mismo patrón probado de image-cascade.ts (fase 1).
 */
function raceRacers(racers: Racer[]): Promise<CoreCallResult> {
  return new Promise((resolve, reject) => {
    let pending = racers.length
    let settled = false
    if (pending === 0) {
      reject(new Error('Sin proveedores en la carrera de código.'))
      return
    }
    const errors: Array<{ id: string; message: string }> = []
    for (const racer of racers) {
      racer
        .run()
        .then((content) => {
          if (!settled) {
            settled = true
            console.warn(`[build:llm] carrera: ganó ${racer.id}`)
            resolve({ content, core: racer.core })
          }
        })
        .catch((err) => {
          errors.push({ id: racer.id, message: err instanceof Error ? err.message.slice(0, 120) : String(err) })
          pending -= 1
          if (pending === 0 && !settled) {
            settled = true
            reject(new AggregateError(errors.map((e) => new Error(`${e.id}: ${e.message}`)), 'Toda la carrera de código falló.'))
          }
        })
    }
  })
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
 * Llamada a NVIDIA NIM (endpoint compatible OpenAI) con thinking DESACTIVADO.
 * Modelo de código abierto 120B-A12B (MoE): rápido y con JSON limpio.
 */
async function nvidiaChat(messages: ChatRequestMessage[], signal?: AbortSignal): Promise<string> {
  const key = process.env.NVIDIA_API_KEY
  if (!key) throw new BuildLlmError('NVIDIA_API_KEY no configurada.', 'provider_error')
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      // CRÍTICO: sin esto el modelo quema TODOS los tokens en razonamiento
      // interno y devuelve content vacío con finish_reason=length.
      chat_template_kwargs: { thinking: false },
      max_tokens: 16_384,
      temperature: 0.6,
    }),
    signal: signal ?? AbortSignal.timeout(NVIDIA_TIMEOUT_MS),
  })
  if (res.status === 429) throw new BuildLlmError('429', 'rate_limited')
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new BuildLlmError(`NVIDIA HTTP ${res.status}: ${detail.slice(0, 160)}`, 'provider_error')
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) throw new BuildLlmError('Respuesta vacía de NVIDIA.', 'empty_response')
  return content
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
 * Llamada de texto con estrategia en DOS fases:
 * - FASE 1 (carrera): NVIDIA NIM ↔ OpenRouter ↔ núcleo z-ai EN PARALELO;
 *   gana el primero en devolver contenido completo. Los tres son IAs de
 *   código abierto / núcleo propio, así que la carrera no cuesta latencia:
 *   el tiempo total es el del más rápido.
 * - FASE 2 (respaldos secuenciales, solo si toda la carrera falló):
 *   Gemini → Groq con un intento cada uno (429 de cuota no se reintenta).
 * 'prefer' se mantiene por compatibilidad de firma; la carrera ya cubre los
 * dos órdenes posibles.
 */
export async function buildChatWithCore(
  messages: ChatRequestMessage[],
  signal?: AbortSignal,
  prefer: CorePreference = 'zai',
): Promise<CoreCallResult> {
  if (signal?.aborted) throw new BuildLlmError('Ejecución cancelada.', 'aborted')

  // FASE 1: carrera paralela de los proveedores rápidos de código abierto.
  const racers: Racer[] = []
  if (process.env.NVIDIA_API_KEY?.trim()) {
    racers.push({ id: 'nvidia', core: `nvidia/${NVIDIA_MODEL}` as BuildCore, run: () => nvidiaChat(messages, signal) })
  }
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    racers.push({
      id: 'openrouter',
      core: `openrouter/${OPENROUTER_BUILD_MODEL}` as BuildCore,
      run: () => openRouterChat(messages, signal),
    })
  }
  racers.push({ id: 'zai', core: 'zai-org:default', run: () => zaiCoreChat(messages, signal) })

  try {
    return await raceRacers(racers)
  } catch (raceErr) {
    if (signal?.aborted) throw new BuildLlmError('Ejecución cancelada.', 'aborted')
    console.warn('[build:llm] la carrera de código falló; probando respaldos secuenciales…')

    // FASE 2: respaldos lentos/secundarios, un intento cada uno.
    const fallbacks: Racer[] = []
    if (process.env.GEMINI_API_KEY?.trim()) {
      fallbacks.push({ id: 'gemini', core: `gemini/${GEMINI_MODEL}` as BuildCore, run: () => geminiChat(messages, signal) })
    }
    if (process.env.GROQ_API_KEY?.trim()) {
      fallbacks.push({ id: 'groq', core: `groq/${GROQ_MODEL}` as BuildCore, run: () => groqChat(messages, signal) })
    }
    let lastError: unknown = raceErr
    for (const fb of fallbacks) {
      try {
        const content = await fb.run()
        console.warn(`[build:llm] respaldo secuencial exitoso: ${fb.id}`)
        return { content, core: fb.core }
      } catch (err) {
        if (signal?.aborted) throw new BuildLlmError('Ejecución cancelada.', 'aborted')
        if (err instanceof BuildLlmError && err.errorType === 'aborted') throw err
        lastError = err
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
