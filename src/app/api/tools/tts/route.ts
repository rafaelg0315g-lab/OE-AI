import { z } from 'zod'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'
import { ELEVEN_PREMADE_VOICES, isPremadeVoice } from '@/lib/voices'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * La lectura en voz alta acepta textos de CUALQUIER longitud razonable:
 * los proveedores imponen un límite por solicitud (~1k caracteres), así
 * que el texto se divide en frases y cada fragmento se sintetiza en
 * paralelo para después unirlos en UN solo audio sin costuras.
 */
const MAX_TTS_CHARS = 30_000
/** Tamaño de fragmento para la voz del núcleo (límite duro del proveedor: 1024). */
const CHUNK_ZAI = 900
/** ElevenLabs admite bastante más texto por solicitud (modelos v2: ~5k). */
const CHUNK_ELEVEN = 2_400
/** Solicitudes simultáneas al proveedor de voz. El núcleo z-ai comparte la
 *  cuota por minuto con el ASR del modo voz y otros SDK: una ráfaga paralela
 *  dispara 429 en cadena, así que el respaldo va SECUENCIAL con reintentos. */
const CONCURRENCY_ZAI = 1
const CONCURRENCY_ELEVEN = 2

/* ── Resiliencia ante límites del proveedor (429 / sin créditos) ────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reintenta operaciones transitorias (429/5xx/red) con retroceso exponencial.
 *  Los errores de cuota marcados (.quota) NO se reintentan: rotar de inmediato. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 700): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if ((err as Error & { quota?: boolean })?.quota) throw err
      const msg = err instanceof Error ? err.message : String(err)
      const transient = /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|too many|rate|temporar|network|fetch failed|econn|socket/i.test(msg)
      if (attempt === attempts || !transient) throw err
      await sleep(baseDelayMs * attempt + Math.random() * 250)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Rompe-circuitos por CLAVE de ElevenLabs: cuando una clave se queda sin
 * créditos (401) o recibe límite (429), se enfría 60 s y las peticiones rotan
 * a la siguiente clave (ELEVENLABS_API_KEY_FALLBACK) o a la voz del núcleo.
 * Así una cuenta agotada no tumba la lectura en voz alta.
 */
let elevenKeys: { key: string; cooldownUntil: number }[] | null = null
function getElevenKeys(): { key: string; cooldownUntil: number }[] {
  if (!elevenKeys) {
    elevenKeys = [process.env.ELEVENLABS_API_KEY?.trim(), process.env.ELEVENLABS_API_KEY_FALLBACK?.trim()]
      .filter((k): k is string => Boolean(k))
      .map((key) => ({ key, cooldownUntil: 0 }))
  }
  return elevenKeys
}
function elevenAvailable(): boolean {
  return getElevenKeys().some((k) => Date.now() >= k.cooldownUntil)
}

const TtsBodySchema = z.object({
  text: z.string().min(1).max(MAX_TTS_CHARS),
  speed: z.number().min(0.5).max(2).optional().default(1),
  /** Voz ElevenLabs solicitada: SOLO se usa si es una premade de la whitelist. */
  voiceId: z.string().max(64).optional(),
})

/** Rango de velocidad aceptado por ElevenLabs y por el núcleo z-ai. */
function clampSpeed(speed: number): number {
  return Math.min(1.2, Math.max(0.7, Math.round(speed * 100) / 100))
}

/** Reduce markdown básico a texto hablable (sin código, sin URLs, sin símbolos). */
function toSpeakable(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' (bloque de código omitido) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~|>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Divide una frase demasiado larga en trozos por palabra. */
function splitLongPiece(sentence: string, maxLen: number): string[] {
  if (sentence.length <= maxLen) return [sentence]
  const pieces: string[] = []
  let rest = sentence
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen)
    if (cut < maxLen * 0.5) cut = maxLen
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) pieces.push(rest)
  return pieces.filter(Boolean)
}

/**
 * Fragmenta el texto respetando frases (el tono no se corta a mitad de
 * palabra): agrupa frases hasta maxLen y parte las que la excedan.
 */
function chunkSpeakable(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const sentences = text.split(/(?<=[.!?…])\s+/)
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    for (const piece of splitLongPiece(sentence, maxLen)) {
      if (current && current.length + 1 + piece.length > maxLen) {
        chunks.push(current)
        current = piece
      } else {
        current = current ? `${current} ${piece}` : piece
      }
    }
  }
  if (current) chunks.push(current)
  return chunks
}

/** Ejecuta fn sobre cada elemento con un máximo de promesas simultáneas.
 *  Con separaciónMs > 0 espacia los arranques (el proveedor de voz limita
 *  peticiones por minuto por cuenta: ráfagas seguidas terminan en 429). */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  separaciónMs = 0,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      if (separaciónMs > 0 && index > 0) await sleep(separaciónMs)
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/* ── Unión de WAV (respaldo z-ai) ───────────────────────────────────────── */

type WavFmt = { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number }

/** Extrae el formato y el PCM crudo de un WAV estándar RIFF. */
function parseWav(buf: Buffer): { fmt: WavFmt; pcm: Buffer } {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV del proveedor de voz inválido.')
  }
  let fmt: WavFmt | null = null
  let pcm: Buffer | null = null
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const dataStart = off + 8
    if (id === 'fmt ' && dataStart + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(dataStart) === 0xfffe ? 1 : buf.readUInt16LE(dataStart),
        channels: buf.readUInt16LE(dataStart + 2),
        sampleRate: buf.readUInt32LE(dataStart + 4),
        bitsPerSample: buf.readUInt16LE(dataStart + 14),
      }
    } else if (id === 'data') {
      pcm = buf.subarray(dataStart, Math.min(dataStart + size, buf.length))
    }
    off = dataStart + size + (size % 2) // los chunks RIFF van alineados a palabra
  }
  if (!fmt || !pcm || fmt.channels < 1 || fmt.bitsPerSample < 8 || fmt.sampleRate < 1) {
    throw new Error('WAV del proveedor de voz sin cabecera válida.')
  }
  return { fmt, pcm }
}

/** Une varios WAV del mismo formato en un único WAV válido (PCM concatenado). */
function mergeWav(buffers: Buffer[]): Buffer {
  if (buffers.length === 1) return buffers[0]
  const parsed = buffers.map(parseWav)
  const first = parsed[0].fmt
  const uniform = parsed.every(
    (p) =>
      p.fmt.audioFormat === first.audioFormat &&
      p.fmt.channels === first.channels &&
      p.fmt.sampleRate === first.sampleRate &&
      p.fmt.bitsPerSample === first.bitsPerSample,
  )
  if (!uniform) throw new Error('Fragmentos de voz con formatos inconsistentes.')
  const blockAlign = (first.channels * first.bitsPerSample) / 8
  if (blockAlign < 1) throw new Error('WAV del proveedor de voz inválido.')
  const totalData = parsed.reduce((n, p) => n + p.pcm.length, 0)
  const dataSize = Math.floor(totalData / blockAlign) * blockAlign

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(first.audioFormat, 20)
  header.writeUInt16LE(first.channels, 22)
  header.writeUInt32LE(first.sampleRate, 24)
  header.writeUInt32LE(first.sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(first.bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, ...parsed.map((p) => p.pcm)])
}

/* ── Proveedores ────────────────────────────────────────────────────────── */

type ZaiClient = {
  audio: {
    tts: {
      create: (args: {
        input: string
        voice: string
        speed?: number
        response_format: string
        stream: boolean
      }) => Promise<Response>
    }
  }
}

async function zaiChunk(zai: ZaiClient, text: string, speed: number): Promise<Buffer> {
  return withRetry(
    async () => {
      const response = await zai.audio.tts.create({
        input: text,
        voice: 'tongtong',
        speed,
        response_format: 'wav',
        stream: false,
      })
      const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()))
      if (buffer.byteLength < 512) throw new Error('El proveedor de voz devolvió audio vacío.')
      return buffer
    },
    4,
    1_500,
  )
}

async function elevenChunk(
  text: string,
  elKey: string,
  voiceId: string,
  modelId: string,
  signal: AbortSignal,
  speed?: number,
): Promise<Buffer> {
  const requestChunk = async (includeSpeed: boolean): Promise<Response> => {
    // ElevenLabs acepta voice_settings.speed en 0.7–1.2. Si la cuenta lo
    // rechaza (HTTP 422) se reintenta UNA vez sin el campo (abajo).
    const voiceSettings: Record<string, number | boolean> = {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    }
    if (includeSpeed && typeof speed === 'number') voiceSettings.speed = speed
    return fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': elKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: voiceSettings,
        }),
        signal,
        cache: 'no-store',
      },
    )
  }
  let res = await requestChunk(typeof speed === 'number' && speed !== 1)
  if (!res.ok && res.status === 422 && typeof speed === 'number' && speed !== 1) {
    // El proveedor rechazó el campo speed: reintento único sin él.
    res = await requestChunk(false)
  }
  if (!res.ok) {
    // 401/403 credenciales o créditos agotados; 429 límite; otros: error del proveedor.
    const detail = (await res.text().catch(() => '')).slice(0, 160)
    const err = new Error(`ElevenLabs HTTP ${res.status}: ${detail}`)
    ;(err as Error & { quota?: boolean }).quota = res.status === 401 || res.status === 403 || res.status === 429
    throw err
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.byteLength < 512) throw new Error('ElevenLabs devolvió audio vacío.')
  return buffer
}

/**
 * POST /api/tools/tts — lectura en voz alta del chat, sin límite práctico
 * de longitud (hasta 30.000 caracteres).
 *
 * Proveedor principal: ElevenLabs (voz premium multilingüe, español nativo)
 * cuando ELEVENLABS_API_KEY está configurada. Si falla (sin créditos, red,
 * credenciales), respalda con la voz del núcleo z-ai para que la lectura
 * nunca quede sin audio. La cabecera X-TTS-Provider informa cuál sirvió y
 * X-TTS-Segments cuántos fragmentos se unieron.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'tools-tts'), 15, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de lecturas por minuto alcanzado. Espera unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  let body: z.infer<typeof TtsBodySchema>
  try {
    body = TtsBodySchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: `Payload inválido: text (1-${MAX_TTS_CHARS.toLocaleString('es')} caracteres) es obligatorio.`, requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  const speakable = toSpeakable(body.text)
  if (!speakable) {
    return Response.json(
      { error: 'No hay texto legible para leer en voz alta (solo código o símbolos).', requestId },
      { status: 422, headers: { 'X-Request-Id': requestId } },
    )
  }

  // Velocidad del habla recortada al rango soportado (0.7–1.2) y voz
  // ElevenLabs: SOLO se acepta una premade de la whitelist; cualquier otro
  // voiceId se ignora y se usa la voz configurada (ELEVENLABS_VOICE_ID).
  const effSpeed = clampSpeed(body.speed)
  const requestedVoiceId = body.voiceId && isPremadeVoice(body.voiceId) ? body.voiceId : null

  const startedAt = Date.now()

  // 1) ElevenLabs (principal): MP3 44.1 kHz · 128 kbps. El MP3 es una
  //    corriente de tramas: unir los fragmentos produce un audio continuo.
  //    Cada fragmento rota entre las claves disponibles: si una se queda sin
  //    créditos (401/429) se enfría 60 s y la siguiente toma el turno; si no
  //    queda ninguna, la voz del núcleo respalda todo el audio.
  if (elevenAvailable()) {
    // Whitelist de voces premade (las "library" exigen plan de pago y
    // devuelven 402 con la cuenta gratuita). Respaldo: Sarah (premade).
    const envVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim() ?? ''
    const safeVoiceId =
      requestedVoiceId ?? (isPremadeVoice(envVoiceId) ? envVoiceId : (ELEVEN_PREMADE_VOICES[0]?.id ?? 'EXAVITQu4vr4xnSDxMaL'))
    const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2'
    try {
      const chunks = chunkSpeakable(speakable, CHUNK_ELEVEN)
      const buffers = await mapPool(chunks, CONCURRENCY_ELEVEN, async (chunk) => {
        let lastErr: unknown
        for (const ks of getElevenKeys()) {
          if (Date.now() < ks.cooldownUntil) continue
          try {
            return await withRetry(() => elevenChunk(chunk, ks.key, safeVoiceId, modelId, request.signal, effSpeed))
          } catch (err) {
            lastErr = err
            if ((err as Error & { quota?: boolean })?.quota) {
              ks.cooldownUntil = Date.now() + 60_000
              console.warn(`[api/tools/tts] clave ElevenLabs …${ks.key.slice(-4)} sin créditos o limitada; roto a la siguiente`)
              continue
            }
            throw err
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error('Sin claves de ElevenLabs disponibles.')
      })
      const merged = Buffer.concat(buffers)
      if (merged.byteLength < 512) throw new Error('ElevenLabs devolvió audio vacío.')

      await recordUsage({
        requestId,
        source: 'tool_tts',
        providerId: 'elevenlabs',
        requestedModelId: `tts:${modelId}`,
        resolvedModelId: `tts:${safeVoiceId}`,
        status: 'ok',
        latencyMs: Date.now() - startedAt,
        promptChars: speakable.length,
      })

      return new Response(new Uint8Array(merged), {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(merged.byteLength),
          'Cache-Control': 'no-store',
          'X-Request-Id': requestId,
          'X-TTS-Provider': 'elevenlabs',
          'X-TTS-Segments': String(buffers.length),
          'X-TTS-Voice': safeVoiceId,
        },
      })
    } catch (err) {
      if (request.signal.aborted) {
        return Response.json({ error: 'Lectura cancelada.', requestId }, { status: 499, headers: { 'X-Request-Id': requestId } })
      }
      console.warn(
        '[api/tools/tts] ElevenLabs no pudo servir el audio completo; respaldo con la voz del núcleo:',
        err instanceof Error ? err.message.slice(0, 140) : err,
      )
      // Respaldo honesto: re-genera TODO con la voz del núcleo para no
      // mezclar formatos (MP3 44.1 kHz + WAV 24 kHz) en un mismo audio.
    }
  }

  // 2) Respaldo: voz del núcleo z-ai (WAV 24 kHz) fragmentado y unido en
  //    un único WAV válido.
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = (await ZAI.create()) as unknown as ZaiClient
    const chunks = chunkSpeakable(speakable, CHUNK_ZAI)
    const buffers = await mapPool(chunks, CONCURRENCY_ZAI, (chunk) => zaiChunk(zai, chunk, effSpeed), 1_200)
    const merged = mergeWav(buffers)
    if (merged.byteLength < 512) throw new Error('El proveedor de voz devolvió audio vacío.')

    await recordUsage({
      requestId,
      source: 'tool_tts',
      providerId: 'zai-org',
      requestedModelId: 'tts:tongtong',
      resolvedModelId: 'tts:tongtong',
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      promptChars: speakable.length,
    })

    return new Response(new Uint8Array(merged), {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(merged.byteLength),
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
        'X-TTS-Provider': 'zai-org',
        'X-TTS-Segments': String(buffers.length),
      },
    })
  } catch (err) {
    if (request.signal.aborted) {
      return Response.json({ error: 'Lectura cancelada.', requestId }, { status: 499, headers: { 'X-Request-Id': requestId } })
    }
    await recordUsage({
      requestId,
      source: 'tool_tts',
      providerId: elevenAvailable() ? 'elevenlabs' : 'zai-org',
      requestedModelId: 'tts:fallback',
      status: 'error',
      errorType: 'tts_error',
      latencyMs: Date.now() - startedAt,
    })
    const message = err instanceof Error ? err.message : 'No se pudo generar el audio.'
    return Response.json({ error: message, requestId }, { status: 502, headers: { 'X-Request-Id': requestId } })
  }
}
