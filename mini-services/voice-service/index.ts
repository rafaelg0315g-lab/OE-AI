/**
 * OE AI LLM — Servicio de voz en tiempo real (puerto 3010)
 *
 * Pipeline: Voz ➡️ Texto ➡️ IA ➡️ Voz, en milisegundos:
 *  1. El navegador envía el micrófono en chunks PCM16 (~100 ms) por WebSocket.
 *  2. El servidor ejecuta VAD (detección de silencio): corta la frase sola.
 *  3. ASR del núcleo transcribe el audio → texto.
 *  4. El texto entra a /api/chat (OE AI LLM, red unificada) por SSE.
 *  5. Conforme llegan los primeros tokens, cada frase se envía a TTS en
 *     streaming (ElevenLabs, respaldo z-ai) y el audio viaja de vuelta por
 *     el mismo WebSocket — la voz empieza ANTES de que la respuesta termine.
 *
 * Autenticidad: usa las cookies del navegador (cuota de invitado) y el token
 * Supabase si existe; consume exactamente la misma cuota que el chat escrito.
 */
import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'

/* ── Entorno: lee el .env raíz del proyecto (clave ElevenLabs, etc.) ────── */
async function loadRootEnv() {
  try {
    const raw = await Bun.file('/home/z/my-project/.env').text()
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m) continue
      // Las claves de ElevenLabs SIEMPRE se toman del .env (rotación de claves
      // sin reinicios intermedios); el resto solo si no viene del proceso.
      const override = m[1].startsWith('ELEVENLABS_')
      if (override || process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    console.log('[voice] sin .env raíz; se usan variables de entorno existentes')
  }
}
await loadRootEnv()

const PORT = 3010
const CHAT_URL = 'http://localhost:3000/api/chat'

/* ── SDK del núcleo (ASR y TTS de respaldo) ─────────────────────────────── */
type ZaiClient = {
  audio: {
    asr: { create: (args: { file_base64: string }) => Promise<{ text?: string }> }
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
let zaiPromise: Promise<ZaiClient> | null = null
async function getZai(): Promise<ZaiClient> {
  if (!zaiPromise) {
    zaiPromise = import('z-ai-web-dev-sdk').then(async (mod) => {
      const zai = (await mod.default.create()) as unknown as ZaiClient
      console.log('[voice] SDK del núcleo listo (ASR + TTS de respaldo)')
      return zai
    })
  }
  return zaiPromise
}
void getZai()

/* ── Utilidades de audio ────────────────────────────────────────────────── */

/** Envuelve PCM16 LE mono en un WAV estándar RIFF. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  const bitsPerSample = 16
  const channels = 1
  const blockAlign = (channels * bitsPerSample) / 8
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Reduce markdown a texto hablable (igual que la ruta /api/tools/tts). */
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

/* ── ASR: ElevenLabs Scribe (precisión élite en español) ────────────── */

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text'

/**
 * Transcribe un WAV con ElevenLabs Scribe (scribe_v1): el modelo de ASR con
 * mejor precisión de español del mercado (SOTA en FLEURS, puntuación y
 * mayúsculas nativas). Rota claves ante 401/403/429 igual que el TTS.
 * Devuelve '' si no hay clave disponible o falla (el llamador usa respaldo).
 */
async function transcribeWithScribe(wav: Buffer, signal: AbortSignal): Promise<string> {
  for (const ks of getElevenKeys()) {
    if (Date.now() < ks.cooldownUntil) continue
    try {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav')
      form.append('model_id', 'scribe_v1')
      form.append('language_code', 'es') // español forzado: cero confusión con otros idiomas
      form.append('tag_audio_events', 'false')
      const res = await fetch(SCRIBE_URL, {
        method: 'POST',
        headers: { 'xi-api-key': ks.key },
        body: form,
        signal,
        cache: 'no-store',
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          ks.cooldownUntil = Date.now() + 60_000
          console.log(`[voice] clave ElevenLabs …${ks.key.slice(-4)} sin créditos (STT); roto de clave`)
          continue
        }
        throw new Error(`Scribe HTTP ${res.status}`)
      }
      const data = (await res.json()) as { text?: string }
      const text = (data.text ?? '').trim()
      if (text) console.log(`[voice] Scribe (es): "${text.slice(0, 90)}"`)
      return text
    } catch (err) {
      if (signal.aborted) throw err
      console.log('[voice] Scribe falló; uso el ASR del núcleo:', err instanceof Error ? err.message : err)
      return ''
    }
  }
  return ''
}

/* ── TTS: ElevenLabs en streaming (principal) con respaldo del núcleo ───── */

/**
 * Voces ElevenLabs "premade" admitidas (copia local de src/lib/voices.ts:
 * el mini-servicio vive fuera de src y no puede importar del proyecto).
 * Las "library" exigen plan de pago (HTTP 402); las premade funcionan gratis.
 */
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Sarah
const ELEVEN_PREMADE_VOICES: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' },
  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' },
  { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' },
]

/** Códigos válidos del modo intérprete ('' = desactivado). */
const TRANSLATOR_TARGETS = new Set(['', 'en', 'fr', 'pt', 'it', 'de'])

type TtsChunk = { mime: string; b64: string }
type VoiceSettings = { voiceId: string; speed: number }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reintentos con retroceso para errores transitorios (429/5xx/red). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 700): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      const transient = /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|too many|rate|temporar|network|fetch failed|econn|socket/i.test(msg)
      if (attempt === attempts || !transient) throw err
      await sleep(baseDelayMs * attempt + Math.random() * 250)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Claves de ElevenLabs con rotación: si la primaria se queda sin créditos
 * (401) o recibe límite (429), se enfría 60 s y la siguiente toma el turno.
 * Con todas agotadas, la voz del núcleo respalda cada frase.
 */
type ElevenKey = { key: string; cooldownUntil: number }
let elevenKeysCache: ElevenKey[] | null = null
function getElevenKeys(): ElevenKey[] {
  if (!elevenKeysCache) {
    elevenKeysCache = [process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_API_KEY_FALLBACK]
      .map((k) => k?.trim())
      .filter((k): k is string => Boolean(k))
      .map((key) => ({ key, cooldownUntil: 0 }))
    if (elevenKeysCache.length > 0) {
      console.log(`[voice] ElevenLabs: ${elevenKeysCache.length} clave(s) activa(s) (…${elevenKeysCache.map((k) => k.key.slice(-4)).join(', …')})`)
    }
  }
  return elevenKeysCache
}

async function synthesizeSentence(
  text: string,
  signal: AbortSignal,
  onChunk: (c: TtsChunk) => void,
  voice: VoiceSettings,
): Promise<{ provider: string; mime: string }> {
  for (const ks of getElevenKeys()) {
    if (Date.now() < ks.cooldownUntil) continue
    const voiceId = voice.voiceId
    const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2'
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`
    const baseSettings = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
    const send = (includeSpeed: boolean) =>
      fetch(ttsUrl, {
        method: 'POST',
        headers: { 'xi-api-key': ks.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: includeSpeed ? { ...baseSettings, speed: voice.speed } : baseSettings,
        }),
        signal,
        cache: 'no-store',
      })
    try {
      let res = await send(true)
      // Cuentas antiguas rechazan el parámetro speed (422): un reintento único
      // sin speed salva la frase (la voz suena a velocidad normal).
      if (res.status === 422) {
        const errText = await res.text().catch(() => '')
        if (/speed/i.test(errText)) {
          console.log('[voice] ElevenLabs rechazó speed (422); reintento sin speed')
          res = await send(false)
        }
      }
      if (!res.ok) {
        // 401/403 sin créditos o credenciales; 429 límite: enfría la clave y
        // rota a la siguiente (no reintenta contra un fallo garantizado).
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          ks.cooldownUntil = Date.now() + 60_000
          console.log(`[voice] clave ElevenLabs …${ks.key.slice(-4)} sin créditos o limitada; roto de clave`)
          continue
        }
        throw new Error(`ElevenLabs HTTP ${res.status}`)
      }
      if (!res.body) throw new Error('ElevenLabs sin cuerpo de streaming')
      const reader = res.body.getReader()
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          bytes += value.length
          onChunk({ mime: 'audio/mpeg', b64: Buffer.from(value).toString('base64') })
        }
      }
      if (bytes < 512) throw new Error('ElevenLabs devolvió audio vacío')
      return { provider: 'elevenlabs', mime: 'audio/mpeg' }
    } catch (err) {
      if (signal.aborted) throw err
      console.log('[voice] ElevenLabs falló para la frase; respaldo z-ai:', err instanceof Error ? err.message : err)
      break
    }
  }

  // Respaldo: voz del núcleo z-ai (WAV completo, un solo chunk).
  const zai = await getZai()
  const response = await withRetry(() =>
    zai.audio.tts.create({
      input: text.slice(0, 900),
      voice: 'tongtong',
      speed: voice.speed,
      response_format: 'wav',
      stream: false,
    }),
  )
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()))
  if (buffer.byteLength < 512) throw new Error('El proveedor de voz devolvió audio vacío')
  onChunk({ mime: 'audio/wav', b64: buffer.toString('base64') })
  return { provider: 'zai-org', mime: 'audio/wav' }
}

/* ── Estado por conexión ────────────────────────────────────────────────── */

const VAD = {
  speechStartFactor: 2.2,
  absoluteFloor: 0.012,
  startChunks: 2,
  // El usuario pidió explícitamente: 2 segundos seguidos de silencio cierran
  // la frase y disparan la respuesta (evita cortes con pausas al pensar).
  hangoverMs: 2_000,
  minSpeechMs: 350,
  maxUtteranceMs: 20_000,
  bargeInChunks: 5, // habla alta sostenida durante la respuesta → interrumpe
  bargeInFactor: 2.6,
}

type VoiceSession = {
  sampleRate: number
  sessionId: string | null
  cookie: string | null
  token: string | null
  muted: boolean
  ttsSid: number
  // Modo dictado (Web Speech activo): el audio se bufferiza para que Scribe
  // transcriba la frase final con máxima precisión; sin turnos automáticos.
  dictation: boolean
  dictationBuf: Buffer[]
  dictationBytes: number
  // Contadores de TTS del turno (para la señal precisa voice:no-audio).
  ttsTried: number
  ttsPlayed: number
  pumpPromise: Promise<void> | null
  // VAD
  noiseFloor: number
  loudStreak: number
  utterance: { parts: Buffer[]; bytes: number; startedAt: number; speechMs: number; endedAt: number | null; loud: number } | null
  // Turno en curso
  turnId: number
  turnBusy: boolean
  turnController: AbortController | null
  ttsQueue: string[]
  ttsBusy: boolean
  watchdog: ReturnType<typeof setTimeout> | null
  // Ajustes de voz anunciados en voice:start (voz premade, velocidad 0.7-1.2
  // y modo intérprete ''|en|fr|pt|it|de).
  voiceId: string
  speed: number
  translatorTarget: string
}

function newSession(): VoiceSession {
  return {
    sampleRate: 16_000,
    sessionId: null,
    cookie: null,
    token: null,
    muted: false,
    ttsSid: 0,
    dictation: false,
    dictationBuf: [],
    dictationBytes: 0,
    ttsTried: 0,
    ttsPlayed: 0,
    pumpPromise: null,
    noiseFloor: 0.02,
    loudStreak: 0,
    utterance: null,
    turnId: 0,
    turnBusy: false,
    turnController: null,
    ttsQueue: [],
    ttsBusy: false,
    watchdog: null,
    voiceId: DEFAULT_VOICE_ID,
    speed: 1,
    translatorTarget: '',
  }
}

/** Divisor de frases para TTS: suelta cada oración apenas está completa. */
class SentenceChunker {
  private buf = ''
  /** Devuelve las frases listas tras añadir texto. */
  push(delta: string): string[] {
    this.buf += delta
    const out: string[] = []
    for (;;) {
      // Fin de oración fuerte, o coma si el buffer ya es largo.
      const strong = this.buf.match(/[\s\S]*?[.!?…\n](\s|$)/)
      let cut = strong ? strong[0].length : 0
      if (!cut && this.buf.length > 220) {
        const comma = this.buf.indexOf(',')
        if (comma > 0) cut = comma + 1
      }
      if (!cut && this.buf.length > 480) cut = this.buf.length
      if (!cut) break
      const sentence = this.buf.slice(0, cut).trim()
      this.buf = this.buf.slice(cut)
      if (sentence) out.push(sentence)
    }
    return out
  }
  flush(): string[] {
    const rest = this.buf.trim()
    this.buf = ''
    return rest ? [rest] : []
  }
}

/* ── Servidor ───────────────────────────────────────────────────────────── */

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path: Caddy lo usa para reenviar al puerto correcto.
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
  maxHttpBufferSize: 2e6,
})

function emit(socket: Socket, event: string, data: unknown) {
  socket.emit(event, data)
}

/**
 * Turno completo con el texto YA transcrito: OE AI LLM (SSE) ➡️ frases ➡️
 * TTS ElevenLabs en streaming. Lo invocan tanto la ruta de audio (ASR del
 * núcleo) como el evento voice:text (Web Speech API del navegador).
 */
async function runTurn(socket: Socket, session: VoiceSession, transcript: string, existing?: AbortController) {
  if (session.turnBusy) return
  const turnId = ++session.turnId
  session.turnBusy = true
  const controller = existing ?? new AbortController()
  session.turnController = controller
  const startedAt = Date.now()

  session.watchdog = setTimeout(() => controller.abort(), 60_000)

  // Los restos de audio dictado de antes del turno se descartan: la próxima
  // frase del usuario se graba limpia, sin eco de la respuesta anterior.
  session.dictationBuf = []
  session.dictationBytes = 0
  session.ttsTried = 0
  session.ttsPlayed = 0

  try {
    emit(socket, 'voice:user-transcript', { turnId, text: transcript })
    console.log(`[voice] #${turnId} usuario: ${transcript.slice(0, 120)}`)

    // OE AI LLM (misma cuota y sesión que el chat escrito) vía SSE.
    emit(socket, 'voice:status', { turnId, phase: 'thinking' })
    const chunker = new SentenceChunker()
    let fullText = ''
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    if (session.cookie) headers.Cookie = session.cookie
    if (session.token) headers.Authorization = `Bearer ${session.token}`

    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers,
      // voice: true → el núcleo responde SIEMPRE en español, breve y sin
      // markdown: el texto se convierte en voz con ElevenLabs.
      body: JSON.stringify({
        sessionId: session.sessionId ?? crypto.randomUUID(),
        message: transcript.slice(0, 4000),
        mode: 'instant',
        webSearch: false,
        voice: true,
        // Modo intérprete: '' mantiene el prompt de voz en español; con un
        // idioma el núcleo REEMPLAZA el system prompt por el de intérprete y
        // responde en ese idioma (eleven_multilingual_v2 lo habla igual).
        translatorTarget: session.translatorTarget,
      }),
      signal: controller.signal,
    })

    // Cookies del navegador/cuota: conserva el huésped para los próximos turnos.
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) {
      const m = setCookie.match(/oe_guest=[^;]+/)
      if (m) session.cookie = m[0]
    }

    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string; errorType?: string } | null
      const message =
        data?.errorType === 'guest_limit_reached'
          ? 'Se agotaron tus 5 chats gratis de esta sesión. Inicia sesión con Google para continuar.'
          : (data?.error ?? `El chat no pudo empezar (HTTP ${res.status}).`)
      emit(socket, 'voice:error', { turnId, message, errorType: data?.errorType ?? null, status: res.status })
      return
    }
    if (!res.body) throw new Error('La respuesta del chat no trae flujo SSE')

    // 3) Relay de deltas + cola de frases para TTS en streaming.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let sseBuf = ''
    // CRÍTICO: cada frase encolada debe despertar la bomba TTS inmediatamente.
    // Antes la bomba solo se lanzaba al inicio del turno (con la cola vacía) y
    // las frases se acumulaban sin sonar: el asistente respondía en silencio.
    const speak = (sentence: string) => {
      const clean = toSpeakable(sentence)
      if (clean) {
        session.ttsQueue.push(clean)
        void pumpTtsAsync(socket, session)
      }
    }
    const drainSpeak = () => {
      for (const s of chunker.flush()) speak(s)
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (controller.signal.aborted) break
      sseBuf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = sseBuf.indexOf('\n\n')) >= 0) {
        const rawEvent = sseBuf.slice(0, idx)
        sseBuf = sseBuf.slice(idx + 2)
        let event = 'message'
        let data = ''
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue
        }
        if (event === 'delta' && typeof payload.text === 'string') {
          fullText += payload.text
          emit(socket, 'voice:assistant-delta', { turnId, text: payload.text })
          for (const s of chunker.push(payload.text)) speak(s)
        } else if (event === 'done') {
          drainSpeak()
        } else if (event === 'error') {
          throw new Error(String(payload.message ?? 'El núcleo no pudo responder.'))
        }
      }
    }
    if (!controller.signal.aborted) drainSpeak()

    if (!fullText.trim()) {
      emit(socket, 'voice:error', { turnId, message: 'OE AI LLM no devolvió respuesta. Inténtalo otra vez.', status: 502 })
      return
    }
    emit(socket, 'voice:assistant-done', { turnId, text: fullText })
    // Espera a que la bomba TTS termine de procesar TODA la cola del turno
    // (síntesis en curso incluida) para saber con certeza si sonó algo.
    await pumpTtsAsync(socket, session)
    if (!controller.signal.aborted && session.ttsTried > 0 && session.ttsPlayed === 0) {
      // Señal UNA VOZ: ningún proveedor sonó → el navegador narra con su
      // síntesis local, con la certeza de que no se solapa con nadie.
      emit(socket, 'voice:no-audio', { turnId, text: fullText })
    }
    console.log(`[voice] #${turnId} respuesta (${((Date.now() - startedAt) / 1000).toFixed(1)}s): ${fullText.slice(0, 100)}`)
  } catch (err) {
    if (!controller.signal.aborted) {
      emit(socket, 'voice:error', {
        turnId,
        message: err instanceof Error ? err.message : 'Fallo inesperado en el turno de voz.',
      })
    }
  } finally {
    if (session.watchdog) clearTimeout(session.watchdog)
    session.watchdog = null
    if (session.turnController === controller) {
      session.turnController = null
      session.turnBusy = false
    }
  }
}

/**
 * Ruta de AUDIO (respaldo cuando no hay Web Speech): ElevenLabs Scribe ➡️
 * (precisión élite en español) ➡️ ASR del núcleo ➡️ runTurn.
 */
async function handleUtterance(socket: Socket, session: VoiceSession, pcm: Buffer) {
  if (session.turnBusy) return
  session.turnBusy = true
  const controller = new AbortController()
  session.turnController = controller
  const asrTurnId = session.turnId + 1
  const asrWatchdog = setTimeout(() => controller.abort(), 30_000)

  try {
    emit(socket, 'voice:status', { turnId: asrTurnId, phase: 'transcribing' })
    const wav = pcmToWav(pcm, session.sampleRate)
    // 1) ElevenLabs Scribe: puntuación, tildes y español real.
    let transcript = ''
    try {
      transcript = await transcribeWithScribe(wav, controller.signal)
    } catch {
      if (controller.signal.aborted) return
    }
    // 2) Respaldo: ASR del núcleo (con reintentos si el proveedor responde 429).
    if (!transcript) {
      const zai = await getZai()
      const asr = await withRetry(() => zai.audio.asr.create({ file_base64: wav.toString('base64') }))
      transcript = (asr.text ?? '').trim()
    }
    if (controller.signal.aborted) return
    if (!transcript) {
      emit(socket, 'voice:notice', { turnId: asrTurnId, message: 'No te escuché bien. Acércate al micrófono e inténtalo de nuevo.' })
      return
    }
    // El testigo (controller y busy) pasa al turno completo sin pausas.
    session.turnBusy = false
    await runTurn(socket, session, transcript, controller)
  } catch (err) {
    if (!controller.signal.aborted) {
      emit(socket, 'voice:error', {
        turnId: asrTurnId,
        message: err instanceof Error ? err.message : 'No se pudo transcribir tu voz.',
      })
    }
  } finally {
    clearTimeout(asrWatchdog)
    if (session.turnController === controller) {
      session.turnController = null
      session.turnBusy = false
    }
  }
}

/** Cola de TTS: sintetiza frases en orden mientras el cliente reproduce. */
async function pumpTts(socket: Socket, session: VoiceSession) {
  if (session.ttsBusy) return
  session.ttsBusy = true
  try {
    // sid MONOTÓNICO POR SESIÓN: si la bomba se relanza (cola vacía entre
    // frases), un contador local reiniciaría en 1 y el cliente mezclaría
    // chunks de frases distintas bajo el mismo sid (audio corrupto).
    while (session.ttsQueue.length > 0) {
      const sentence = session.ttsQueue.shift() as string
      const myController = session.turnController
      if (!myController || myController.signal.aborted) break
      const thisSid = ++session.ttsSid
      const turnId = session.turnId
      session.ttsTried += 1
      try {
        const { provider, mime } = await synthesizeSentence(
          sentence,
          myController.signal,
          (chunk) => {
            emit(socket, 'voice:tts-chunk', { turnId, sid: thisSid, mime: chunk.mime, b64: chunk.b64 })
          },
          { voiceId: session.voiceId, speed: session.speed },
        )
        session.ttsPlayed += 1
        emit(socket, 'voice:tts-sentence', { turnId, sid: thisSid, mime, provider, done: true })
        console.log(`[voice] TTS frase ${thisSid} (${provider}, ${sentence.length} chars)`)
      } catch (err) {
        if (myController.signal.aborted) break
        emit(socket, 'voice:notice', { turnId, message: 'Una frase no pudo sonar; sigo con el resto.' })
        console.log('[voice] error TTS de frase:', err instanceof Error ? err.message : err)
      }
    }
  } finally {
    session.ttsBusy = false
  }
}

/** Lanza (o se une a) la bomba TTS y devuelve la promesa de la cola entera. */
function pumpTtsAsync(socket: Socket, session: VoiceSession): Promise<void> {
  const running = session.pumpPromise
  if (running) return running
  const p = pumpTts(socket, session).finally(() => {
    session.pumpPromise = null
  })
  session.pumpPromise = p
  return p
}

io.on('connection', (socket) => {
  const session = newSession()
  session.cookie = socket.handshake.headers.cookie ?? null
  const auth = (socket.handshake.auth ?? {}) as { token?: string; sessionId?: string }
  session.token = typeof auth.token === 'string' && auth.token.length > 10 ? auth.token : null
  session.sessionId =
    typeof auth.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(auth.sessionId) ? auth.sessionId : null
  console.log(`[voice] cliente conectado: ${socket.id} (cookie: ${Boolean(session.cookie)}, token: ${Boolean(session.token)})`)

  socket.on(
    'voice:start',
    (data: { sampleRate?: number; voiceId?: string; speed?: number; translatorTarget?: string } | undefined) => {
      const rate = Number(data?.sampleRate)
      if (Number.isFinite(rate) && rate >= 8_000 && rate <= 96_000) session.sampleRate = Math.round(rate)
      // Voz premade: se acepta SOLO la whitelist (16-64 chars por si algún día
      // cambian los ids); cualquier otro valor cae a la voz por defecto.
      const reqVoiceId = typeof data?.voiceId === 'string' ? data.voiceId : ''
      const premade =
        reqVoiceId.length >= 16 && reqVoiceId.length <= 64
          ? ELEVEN_PREMADE_VOICES.find((v) => v.id === reqVoiceId)
          : undefined
      session.voiceId = premade?.id ?? DEFAULT_VOICE_ID
      const reqSpeed = Number(data?.speed)
      session.speed = Number.isFinite(reqSpeed) ? Math.min(1.2, Math.max(0.7, Math.round(reqSpeed * 100) / 100)) : 1
      const reqTarget = typeof data?.translatorTarget === 'string' ? data.translatorTarget : ''
      session.translatorTarget = TRANSLATOR_TARGETS.has(reqTarget) ? reqTarget : ''
      session.muted = false
      session.dictation = false
      session.dictationBuf = []
      session.dictationBytes = 0
      emit(socket, 'voice:status', { turnId: session.turnId, phase: 'listening' })
      console.log(
        `[voice] sesión de voz iniciada (${socket.id}, ${session.sampleRate} Hz, voz ${
          premade?.name ?? 'Sarah (default)'
        }, speed ${session.speed}${session.translatorTarget ? `, traductor → ${session.translatorTarget}` : ''})`,
      )
    },
  )

  /**
   * Modo dictado (Web Speech del navegador activo): el audio que llega se
   * bufferiza para transcribirlo con ElevenLabs Scribe al fin de la frase,
   * pero el NAVEGADOR lleva el ritmo (subtítulos en vivo + silencio de 2 s
   * → voice:utterance-end). Sin turnos automáticos ni barge-in por eco.
   */
  socket.on('voice:dictation', (data: { active?: boolean } | undefined) => {
    const active = Boolean(data?.active)
    if (session.dictation !== active) console.log(`[voice] modo dictado (Web Speech): ${active}`)
    session.dictation = active
    session.dictationBuf = []
    session.dictationBytes = 0
  })

  socket.on('voice:mute', (data: { muted?: boolean } | undefined) => {
    session.muted = Boolean(data?.muted)
    if (session.muted && session.utterance) session.utterance = null
  })

  /**
   * Fin de la frase dictada (2 s de silencio detectados por el navegador).
   * El audio bufferizado del dictado se transcribe con ElevenLabs Scribe
   * (máxima precisión de español) y el texto del navegador solo respalda
   * si no hay audio o Scribe falla. El subtítulo provisional se corrige
   * con voice:user-transcript antes de responder.
   */
  socket.on('voice:utterance-end', async (data: { text?: string } | undefined) => {
    const fallbackText = (typeof data?.text === 'string' ? data.text : '').trim().slice(0, 4000)
    if (session.muted || session.turnBusy) return
    const pcm = session.dictationBuf.length > 0 ? Buffer.concat(session.dictationBuf) : null
    session.dictationBuf = []
    session.dictationBytes = 0
    const controller = new AbortController()
    session.turnController = controller
    session.turnBusy = true // reserva el turno mientras Scribe trabaja
    try {
      if (pcm && pcm.length > 16_000) {
        // ≥ ~0,5 s de audio real: merece transcripción de élite.
        emit(socket, 'voice:status', { turnId: session.turnId + 1, phase: 'transcribing' })
        const text = await transcribeWithScribe(pcmToWav(pcm, session.sampleRate), controller.signal)
        if (controller.signal.aborted) return
        if (text) {
          session.turnBusy = false
          await runTurn(socket, session, text, controller)
          if (!session.turnBusy) emit(socket, 'voice:status', { turnId: session.turnId, phase: 'listening' })
          return
        }
      }
      if (fallbackText) {
        session.turnBusy = false
        await runTurn(socket, session, fallbackText, controller)
        if (!session.turnBusy) emit(socket, 'voice:status', { turnId: session.turnId, phase: 'listening' })
        return
      }
      // Ni audio útil ni texto: vuelve a escuchar sin gastar turno.
      emit(socket, 'voice:notice', { turnId: session.turnId, message: 'No te escuché bien. Acércate al micrófono e inténtalo de nuevo.' })
    } catch (err) {
      if (!controller.signal.aborted) {
        emit(socket, 'voice:error', {
          turnId: session.turnId,
          message: err instanceof Error ? err.message : 'No se pudo transcribir tu voz.',
        })
      }
    } finally {
      if (session.turnController === controller) {
        session.turnController = null
        session.turnBusy = false
      }
    }
  })

  socket.on('voice:text', async (data: { text?: string } | undefined) => {
    const text = (typeof data?.text === 'string' ? data.text : '').trim().slice(0, 4000)
    if (!text || session.muted || session.turnBusy) return
    await runTurn(socket, session, text)
    if (!session.turnBusy) emit(socket, 'voice:status', { turnId: session.turnId, phase: 'listening' })
  })

  socket.on('voice:audio', (data: { b64?: string; rms?: number } | undefined) => {
    if (session.muted || !data?.b64) return
    const rms = Number(data.rms)
    if (!Number.isFinite(rms)) return
    const now = Date.now()
    // Duración REAL del chunk (PCM16 mono): el cliente captura a la tasa
    // nativa del dispositivo y remuestrea a 16 kHz, así que los chunks no
    // miden exactamente 100 ms — medirlos mal sesga el VAD (cortes prematuros
    // o frases que nunca cierran).
    const pcmChunk = Buffer.from(data.b64, 'base64')
    if (pcmChunk.length === 0) return
    const chunkMs = Math.max(40, Math.round((pcmChunk.length / 2 / session.sampleRate) * 1000))

    // MODO DICTADO: solo se bufferiza el audio (para Scribe); el navegador
    // decide cuándo termina la frase y dispara voice:utterance-end.
    if (session.dictation) {
      if (session.turnBusy) return // no capturar mientras OE AI habla
      session.dictationBuf.push(pcmChunk)
      session.dictationBytes += pcmChunk.length
      // Tope de seguridad: ~2 min de audio (recorta por el principio).
      while (session.dictationBytes > 3_840_000 && session.dictationBuf.length > 1) {
        const dropped = session.dictationBuf.shift()
        session.dictationBytes -= dropped?.length ?? 0
      }
      return
    }

    // Barge-in: habla alta sostenida mientras OE AI responde → interrumpe.
    if (session.turnBusy && rms > Math.max(VAD.absoluteFloor, session.noiseFloor) * VAD.bargeInFactor) {
      session.loudStreak += 1
      if (session.loudStreak >= VAD.bargeInChunks) {
        console.log('[voice] barge-in: el usuario interrumpe la respuesta')
        interrupt(socket, session)
        session.loudStreak = 0
        session.utterance = { parts: [], bytes: 0, startedAt: now, speechMs: 0, endedAt: null, loud: 0 }
      }
    } else {
      session.loudStreak = Math.max(0, session.loudStreak - 1)
    }

    const threshold = Math.max(VAD.absoluteFloor, session.noiseFloor * VAD.speechStartFactor)
    const isSpeech = rms >= threshold

    if (session.turnBusy && !session.utterance) return // no guarda audio durante la respuesta

    if (!session.utterance) {
      // Escucha pasiva: adapta el piso de ruido con el silencio.
      if (!isSpeech) session.noiseFloor = Math.min(0.06, session.noiseFloor * 1.01 + rms * 0.002)
      if (isSpeech) {
        session.utterance = { parts: [], bytes: 0, startedAt: now, speechMs: chunkMs, endedAt: null, loud: 0 }
      }
      return
    }

    // Dentro de una frase en construcción.
    const u = session.utterance
    u.parts.push(pcmChunk)
    u.bytes += pcmChunk.length
    if (isSpeech) {
      u.speechMs += chunkMs
      u.endedAt = null
    } else if (u.speechMs >= VAD.minSpeechMs) {
      u.endedAt = u.endedAt ?? now
    }

    const silenceMs = u.endedAt ? now - u.endedAt : 0
    const elapsed = now - u.startedAt
    if ((u.endedAt && silenceMs >= VAD.hangoverMs) || elapsed >= VAD.maxUtteranceMs) {
      const pcm = Buffer.concat(u.parts)
      session.utterance = null
      if (u.speechMs >= VAD.minSpeechMs) {
        void handleUtterance(socket, session, pcm).then(() => {
          if (!session.turnBusy) emit(socket, 'voice:status', { turnId: session.turnId, phase: 'listening' })
        })
        void pumpTts(socket, session)
      }
    }
  })

  /** El usuario corta su propia frase (botón "listo" opcional). */
  socket.on('voice:stop-speech', () => {
    const u = session.utterance
    if (u && u.speechMs >= VAD.minSpeechMs && !session.turnBusy) {
      const pcm = Buffer.concat(u.parts)
      session.utterance = null
      void handleUtterance(socket, session, pcm).then(() => {
        if (!session.turnBusy) emit(socket, 'voice:status', { turnId: session.turnId, phase: 'listening' })
      })
      void pumpTts(socket, session)
    }
  })

  /** Interrupción manual (toque sobre el orbe o botón). */
  socket.on('voice:interrupt', () => {
    interrupt(socket, session)
  })

  function interrupt(socket: Socket, session: VoiceSession) {
    session.ttsQueue = []
    session.utterance = null
    session.loudStreak = 0
    session.dictationBuf = []
    session.dictationBytes = 0
    if (session.turnController) {
      session.turnController.abort()
      session.turnController = null
    }
    session.turnBusy = false
    emit(socket, 'voice:status', { turnId: session.turnId, phase: 'listening' })
  }

  socket.on('voice:end', () => {
    interrupt(socket, session)
  })

  socket.on('disconnect', () => {
    interrupt(socket, session)
    console.log(`[voice] cliente desconectado: ${socket.id}`)
  })

  socket.on('error', (error) => {
    console.error(`[voice] error de socket (${socket.id}):`, error)
  })
})

httpServer.listen(PORT, () => {
  console.log(`[voice] servicio de voz en tiempo real en el puerto ${PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
