/**
 * Cliente DIRECTO de Google Gemini (AI Studio / generativelanguage) — sin SDK
 * del sandbox. Su propósito es servir como RESPALDO en producción (p. ej.
 * Vercel), donde el núcleo z-ai (SDK del entorno OE) no tiene credenciales.
 *
 * Rutas cubiertas (todas con GEMINI_API_KEY):
 * - Chat texto y VISIÓN (inlineData) → modelo configurable, por defecto el
 *   mismo del Constructor (GEMINI_BUILD_MODEL / gemini-3.1-pro-preview).
 * - Generación de imagen → cascade gemini-2.5-flash-image → gemini-3-pro-image-preview.
 * - Edición de imagen → imagen de entrada (inlineData) + prompt → imagen salida.
 * - Búsqueda web → herramienta google_search (grounding) con fuentes citadas.
 * - Transcripción de audio (ASR) → modelo multimodal con inlineData de audio.
 *
 * NOTA de cuota: la capa gratuita de Gemini puede agotarse (429) o tener
 * "limit: 0" en modelos de imagen sin facturación. Por eso SIEMPRE se usa como
 * miembro de una cascada (z-ai → Gemini → OpenRouter → …), nunca como única vía.
 */
import {
  ProviderError,
  messageChars,
  type AdapterChatOptions,
  type ChatRequestMessage,
  type NormalizedCompletion,
  type RoutableRoute,
} from './types'
import { MAX_ASSISTANT_CONTENT_CHARS } from './types-helpers'
import type { WebSource } from './tools/web-search'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Modelo de texto/visión (configurable; coincide con el del Constructor). */
export const GEMINI_DIRECT_CHAT_MODEL =
  process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_BUILD_MODEL || 'gemini-3.1-pro-preview'

/** Modelos de imagen en orden de preferencia (cascade interna). */
const GEMINI_IMAGE_MODELS = (
  process.env.GEMINI_IMAGE_MODEL ? [process.env.GEMINI_IMAGE_MODEL] : ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview']
) as string[]

const CHAT_TIMEOUT_MS = 150_000 // respuestas de código largas (16k tokens de salida) tardan >90s
const IMAGE_TIMEOUT_MS = 90_000
const SEARCH_TIMEOUT_MS = 25_000

interface GeminiPart {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
}

interface GeminiBody {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
    groundingMetadata?: { groundingChunks?: GeminiGroundingChunk[] }
  }>
  promptFeedback?: { blockReason?: string }
  error?: { code?: number; message?: string; status?: string }
  usageMetadata?: { totalTokenCount?: number }
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string }
}

/** Route virtual para los respaldos en ejecución del chat. */
export const GEMINI_DIRECT_ROUTE: RoutableRoute = {
  key: 'gemini-direct:default',
  providerId: 'gemini-direct',
  catalogModelId: null,
  providerModelId: GEMINI_DIRECT_CHAT_MODEL,
  label: 'Google Gemini (respaldo directo, AI Studio)',
  fromAdminConfig: false,
}

/** Convierte un data URL "data:image/png;base64,…" en { mimeType, data }. */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim())
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

/** Llamada generateContent nativa con manejo honesto de errores de cuota. */
async function generateContent(model: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<GeminiBody> {
  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) throw new ProviderError('GEMINI_API_KEY no configurada.', 'provider_not_configured')
  let res: Response
  try {
    res = await fetch(`${BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new ProviderError('Solicitud cancelada.', 'client_cancelled')
    }
    throw new ProviderError('Gemini no alcanzable (error de red).', 'provider_error')
  }
  const data = (await res.json().catch(() => null)) as GeminiBody | null
  if (res.status === 429) {
    const quotaText = JSON.stringify(data ?? {})
    const zeroQuota = /limit['"]?\s*[:=]\s*['"]?0\b/.test(quotaText)
    throw new ProviderError(
      zeroQuota
        ? 'Gemini: cuota del modelo = 0 (requiere facturación habilitada en el proyecto Google).'
        : 'Gemini: cuota free tier agotada por ahora (429).',
      'provider_rate_limited',
    )
  }
  if (!res.ok) {
    const detail = data?.error?.message?.slice(0, 160) || `HTTP ${res.status}`
    throw new ProviderError(`Gemini rechazó la solicitud: ${detail}`, 'provider_error')
  }
  if (!data) throw new ProviderError('Gemini devolvió una respuesta ilegible.', 'empty_response')
  const block = data.promptFeedback?.blockReason
  if (block) throw new ProviderError(`Gemini bloqueó la solicitud (${block}).`, 'provider_error')
  return data
}

/** Convierte mensajes estilo OpenAI (texto + image_url data URL) a formato Gemini. */
function toGeminiContents(messages: ChatRequestMessage[]): { system: string | null; contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> } {
  const systemParts: string[] = []
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = []
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : '')
      continue
    }
    const parts: GeminiPart[] = []
    if (typeof m.content === 'string') {
      parts.push({ text: m.content })
    } else {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ text: p.text })
        if (p.type === 'image_url') {
          const parsed = parseDataUrl(p.image_url.url)
          if (parsed) parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } })
        }
      }
    }
    if (parts.length === 0) continue
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }
  return { system: systemParts.join('\n\n').trim() || null, contents }
}

/**
 * Chat directo (texto y visión). Compatible con NormalizedCompletion para que
 * el enrutador del chat pueda usarla como respaldo en ejecución.
 */
export async function geminiChatDirect(options: AdapterChatOptions): Promise<NormalizedCompletion> {
  const started = Date.now()
  const { system, contents } = toGeminiContents(options.messages)
  if (contents.length === 0) throw new ProviderError('No hay contenido para enviar a Gemini.', 'provider_error')

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 16_384 },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  }
  const data = await generateContent(GEMINI_DIRECT_CHAT_MODEL, body, CHAT_TIMEOUT_MS, options.signal)
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim()
  if (!text) {
    throw new ProviderError(`Gemini devolvió respuesta vacía (${data.candidates?.[0]?.finishReason ?? 'sin candidato'}).`, 'empty_response')
  }
  const content = text.slice(0, MAX_ASSISTANT_CONTENT_CHARS)
  return {
    content,
    providerReportedModel: GEMINI_DIRECT_CHAT_MODEL,
    latencyMs: Date.now() - started,
    promptChars: options.messages.reduce((acc, m) => acc + messageChars(m), 0),
    completionChars: content.length,
  }
}

/** Mini-adaptador compatible con el `runWith` de /api/chat (sin streaming). */
export function createGeminiDirectMiniAdapter() {
  return {
    id: 'gemini-direct',
    label: 'Google Gemini (respaldo directo)',
    capabilities: { streaming: false },
    chat: geminiChatDirect,
  }
}

/** Aspecto soportado por los modelos de imagen de Gemini (cascada 2.5/3.0). */
function aspectFromSize(size: string): string {
  switch (size) {
    case '768x1344':
    case '720x1440':
      return '9:16'
    case '864x1152':
      return '3:4'
    case '1152x864':
      return '4:3'
    case '1344x768':
    case '1440x720':
      return '16:9'
    default:
      return '1:1'
  }
}

function imageFromResponse(data: GeminiBody): { buffer: Buffer; mime: string } | null {
  const parts = data.candidates?.[0]?.content?.parts ?? []
  for (const p of parts) {
    if (p.inlineData?.data) {
      return {
        buffer: Buffer.from(p.inlineData.data, 'base64'),
        mime: p.inlineData.mimeType || 'image/png',
      }
    }
  }
  return null
}

/**
 * Generación de imagen con cascade interna de modelos de Gemini.
 * Lanza ProviderError si NINGÚN modelo produce imagen (p. ej. cuota 0).
 */
export async function geminiImageGenerate(prompt: string, size: string, signal?: AbortSignal): Promise<{ buffer: Buffer; mime: string; model: string }> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 900) }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: aspectFromSize(size) },
    },
  }
  let lastErr: unknown = null
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      const data = await generateContent(model, body, IMAGE_TIMEOUT_MS, signal)
      const img = imageFromResponse(data)
      if (img) return { ...img, model }
      lastErr = new ProviderError(`Gemini ${model}: sin imagen en la respuesta.`, 'empty_response')
    } catch (err) {
      lastErr = err
      // 429/cuota 0: probar el siguiente modelo de inmediato.
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new ProviderError('Gemini no pudo generar la imagen.', 'provider_error')
}

/** Edición de imagen: imagen de entrada (data URL) + instrucción → imagen salida. */
export async function geminiImageEdit(
  prompt: string,
  imageDataUrl: string,
  size: string,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; mime: string; model: string }> {
  const parsed = parseDataUrl(imageDataUrl)
  if (!parsed) throw new ProviderError('La imagen de entrada no es un data URL válido.', 'provider_error')
  const body: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: parsed.mimeType, data: parsed.data } }, { text: prompt.slice(0, 900) }],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: aspectFromSize(size) },
    },
  }
  let lastErr: unknown = null
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      const data = await generateContent(model, body, IMAGE_TIMEOUT_MS, signal)
      const img = imageFromResponse(data)
      if (img) return { ...img, model }
      lastErr = new ProviderError(`Gemini ${model}: sin imagen en la respuesta de edición.`, 'empty_response')
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProviderError('Gemini no pudo editar la imagen.', 'provider_error')
}

/** Búsqueda web con grounding nativo (google_search): fuentes citadas reales. */
export async function geminiSearchWeb(query: string, num = 6): Promise<WebSource[]> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: query.slice(0, 380) }] }],
    tools: [{ google_search: {} }],
  }
  const data = await generateContent(GEMINI_DIRECT_CHAT_MODEL, body, SEARCH_TIMEOUT_MS)
  const chunks = (data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) as GeminiGroundingChunk[]
  const sources: WebSource[] = []
  for (const chunk of chunks) {
    const url = (chunk.web?.uri ?? '').slice(0, 500)
    const name = (chunk.web?.title ?? '').slice(0, 160)
    if (!url || !name) continue
    let hostName = 'web'
    try {
      hostName = new URL(url).hostname
    } catch {
      /* host genérico */
    }
    sources.push({ name, url, hostName, snippet: '', date: null })
    if (sources.length >= num) break
  }
  if (sources.length === 0) throw new ProviderError('Gemini grounding no devolvió fuentes.', 'empty_response')
  return sources
}

/** Transcripción de audio (respaldo ASR): audio inline + instrucción literal. */
export async function geminiTranscribeAudio(fileBase64: string, mimeType: string, language?: string): Promise<string> {
  const instruction = language
    ? `Transcribe literalmente este audio${language === 'es' ? ' en español' : ''}. Responde SOLO con la transcripción, sin comentarios.`
    : 'Transcribe literalmente este audio en su idioma original. Responde SOLO con la transcripción, sin comentarios.'
  const body: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType, data: fileBase64 } }, { text: instruction }],
      },
    ],
  }
  const data = await generateContent(GEMINI_DIRECT_CHAT_MODEL, body, CHAT_TIMEOUT_MS)
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()
  if (!text) throw new ProviderError('Gemini no reconoció ninguna voz en el audio.', 'empty_response')
  return text.slice(0, 4000)
}

/** Detección del MIME real por magic bytes (los proveedores a veces mienten). */
export function sniffImageMime(buffer: Buffer): string {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return 'image/png'
}
