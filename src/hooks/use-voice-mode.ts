'use client'

/**
 * use-voice-mode — Modo Voz en tiempo real de OE AI LLM.
 *
 * Pipeline (estilo ChatGPT, coste cero en el navegador):
 *  1. TRANSCRIPCIÓN HÍBRIDA (lo mejor de cada mundo):
 *     · Web Speech API del navegador → subtítulos provisionales EN VIVO
 *       mientras hablas (instantáneos, gratis).
 *     · Al detectar 2 s de silencio, el audio de la frase viaja al servicio
 *       de voz y se transcribe con ElevenLabs Scribe (el ASR con mejor
 *       precisión de español del mercado): el subtítulo provisional se
 *       reemplaza por la transcripción EXACTA antes de responder.
 *     · Sin Web Speech (Firefox) o si su servicio falla: VAD del servidor
 *       + Scribe directamente. Último recurso: ASR del núcleo.
 *  2. SILENCIO: 2 segundos sin hablar → se envía la frase y OE AI responde.
 *  3. RESPUESTA: el modelo responde en español por escrito (subtítulos) y
 *     cada frase se convierte en voz con ElevenLabs (respaldo: voz del
 *     núcleo; último recurso: síntesis local del navegador).
 *
 * REGLA DE ORO DEL AUDIO — UNA SOLA VOZ SUENA:
 *  · La síntesis local del navegador SOLO entra cuando ningún proveedor
 *    de voz pudo sonar (señal precisa `voice:no-audio` + margen de gracia).
 *  · Si llega audio premium mientras la voz local hablaba, la local se
 *    cancela al instante: nunca dos voces a la vez (era la interferencia).
 *
 * BUG DE CHROME EVITADO: pedir `new AudioContext({ sampleRate: 16_000 })`
 * produce un flujo de micrófono SILENTE en Windows/algunos dispositivos
 * cuando la tasa del contexto difiere de la nativa del hardware. El contexto
 * se abre a la tasa nativa y el remuestreo a 16 kHz ocurre en el cliente.
 *
 * AJUSTES DE VOZ: al abrir la sesión se leen oe-settings (localStorage) y
 * voice:start anuncia { voiceId, speed, translatorTarget } para que TODO el
 * pipeline (LLM, ElevenLabs y modo intérprete) use la configuración elegida.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '@/components/auth/auth-provider'
import { readOeSettings } from '@/lib/settings'

export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

export type VoiceTurn = { who: 'user' | 'ai'; text: string }

type TtsChunkEvent = { turnId: number; sid: number; mime: string; b64: string }
type TtsSentenceEvent = { turnId: number; sid: number; mime: string }
type StatusEvent = { turnId: number; phase: 'listening' | 'transcribing' | 'thinking' }
type TranscriptEvent = { turnId: number; text: string }
type DeltaEvent = { turnId: number; text: string }
type DoneEvent = { turnId: number; text?: string }
type NoticeEvent = { turnId: number; message: string }
type ErrorEvent = { turnId: number; message: string; errorType?: string | null; status?: number }
type NoAudioEvent = { turnId: number; text: string }

/* ── Web Speech API (tipos mínimos; no están en todas las lib.dom) ──────── */
type SrAlternative = { transcript: string }
type SrResult = ArrayLike<SrAlternative> & { isFinal: boolean }
type SrResultList = ArrayLike<SrResult>
type SrResultEvent = { resultIndex: number; results: SrResultList }
type SrErrorEvent = { error: string; message?: string }
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SrResultEvent) => void) | null
  onerror: ((event: SrErrorEvent) => void) | null
  onend: (() => void) | null
  onspeechend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/** SpeechRecognition (Chrome/Edge/Safari) o webkitSpeechRecognition. */
function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function spanishLocale(): string {
  if (typeof navigator !== 'undefined' && navigator.language?.startsWith('es')) return navigator.language
  return 'es-ES'
}

const GATEWAY_URL = '/?XTransformPort=3010'
const WIRE_RATE = 16_000 // todo el audio viaja remuestreado a 16 kHz
const CHUNK_SAMPLES = 1600 // ~100 ms a 16 kHz
const SILENCE_TO_REPLY_MS = 2_000 // regla del producto: 2 s de silencio → responder
const LOCAL_FALLBACK_GRACE_MS = 1_200 // margen antes de hablar con la voz local

export function useVoiceMode(options: { onTurnComplete?: (sessionId: string) => void }) {
  const { onTurnComplete } = options
  const auth = useAuth()

  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [muted, setMuted] = useState(false)
  const [transcript, setTranscript] = useState('') // dictado provisional en vivo
  const [reply, setReply] = useState('') // respuesta en vivo del modelo
  const [turns, setTurns] = useState<VoiceTurn[]>([]) // historial de subtítulos
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0) // 0..1 para el orbe
  // Ajustes de voz ACTIVOS (leídos de oe-settings al abrir la sesión): el
  // overlay muestra "Voz: …" y el chip del intérprete con estos valores.
  const [voiceName, setVoiceName] = useState('')
  const [translatorTarget, setTranslatorTarget] = useState('')

  // Refs de infraestructura (fuera del estado: el audio no re-renderiza).
  const socketRef = useRef<Socket | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const rafRef = useRef<number | null>(null)

  const mutedRef = useRef(false)
  const phaseRef = useRef<VoicePhase>('idle')
  const sessionIdRef = useRef<string | null>(null)
  const turnRef = useRef(0) // turno actual (descarta eventos viejos)
  // Vigilancia de micrófono mudo: avisa una vez si el audio llega en silencio
  // (permiso parcial, dispositivo apagado o el bug de Chrome descrito arriba).
  const silentSinceRef = useRef<number | null>(null)
  const micWarnedRef = useRef(false)

  // Web Speech API (subtítulos provisionales en el navegador).
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const webSpeechActiveRef = useRef(false) // el servicio de reconocimiento funciona
  const recAliveRef = useRef(false) // hay una sesión de reconocimiento abierta
  const finalTextRef = useRef('') // dictado final acumulado (aún sin enviar)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRecognitionRef = useRef<() => boolean>(() => false)
  const ttsAudioThisTurn = useRef(false) // llegó audio TTS en el turno actual
  // UNA SOLA VOZ: ¿está sonando ahora la síntesis local del navegador?
  const localSpeakingRef = useRef(false)
  const localFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cola de reproducción TTS
  const pendingTts = useRef(new Map<number, { mime: string; chunks: Uint8Array[] }>())
  const nextSid = useRef(0) // siguiente frase esperada en orden
  const chainEnd = useRef(0) // t del fin del audio programado
  const liveSources = useRef<AudioBufferSourceNode[]>([])
  const awaitingTts = useRef(0) // frases encoladas sin reproducir
  const llmDone = useRef(false)

  const setPhaseSafe = useCallback((p: VoicePhase) => {
    phaseRef.current = p
    setPhase(p)
  }, [])

  /** Empuja un turno al historial de subtítulos (máx. 40 visibles). */
  const pushTurn = useCallback((who: 'user' | 'ai', text: string) => {
    const clean = text.trim()
    if (!clean) return
    setTurns((prev) => [...prev.slice(-39), { who, text: clean }])
  }, [])

  const stopSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }, [])

  /* ── Envío de la frase (fin del dictado) ────────────────────────────────── */

  /**
   * Fin de la frase por silencio de 2 s. Con Web Speech activo se manda
   * `voice:utterance-end`: el servidor transcribe el MISMO audio con
   * ElevenLabs Scribe (precisión élite en español) y corrige el subtítulo
   * provisional; el texto del navegador solo es respaldo. Sin Web Speech,
   * el VAD del servidor dispara el turno por su cuenta con ese mismo audio.
   */
  const submitDictation = useCallback(() => {
    const text = finalTextRef.current.trim()
    finalTextRef.current = ''
    stopSilenceTimer()
    if (phaseRef.current === 'listening') setPhaseSafe('transcribing')
    socketRef.current?.emit('voice:utterance-end', { text })
  }, [setPhaseSafe, stopSilenceTimer])

  /** 2 segundos sin hablar → se envía lo dictado y OE AI responde. */
  const armSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null
      if (!mutedRef.current) submitDictation()
    }, SILENCE_TO_REPLY_MS)
  }, [submitDictation])

  /** Abre (o reabre) el reconocimiento del navegador. false = no disponible. */
  const startRecognition = useCallback((): boolean => {
    const Ctor = getSpeechRecognition()
    if (!Ctor) return false
    try {
      recognitionRef.current?.abort()
    } catch {
      /* no había sesión */
    }
    let rec: SpeechRecognitionLike
    try {
      rec = new Ctor()
    } catch {
      return false
    }
    rec.lang = spanishLocale()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) finalTextRef.current = `${finalTextRef.current} ${text}`.trim()
        else interim += text
      }
      const shown = `${finalTextRef.current} ${interim}`.trim()
      if (shown) {
        setTranscript(shown) // subtítulos provisionales en vivo, como ChatGPT
        armSilenceTimer() // mientras hable se pospone el envío
      }
    }
    rec.onspeechend = () => armSilenceTimer()
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      // Servicio de reconocimiento caído o sin permiso → el audio sigue
      // viajando al servidor: Scribe/VAD del núcleo toma el control.
      webSpeechActiveRef.current = false
      recAliveRef.current = false
      socketRef.current?.emit('voice:dictation', { active: false })
      try {
        rec.abort()
      } catch {
        /* ya cerrado */
      }
      if (recognitionRef.current === rec) recognitionRef.current = null
      stopSilenceTimer()
      finalTextRef.current = ''
      setNotice('El reconocimiento del navegador no está disponible; transcribo yo mismo tu audio.')
    }
    rec.onend = () => {
      recAliveRef.current = false
      // Chrome corta la sesión periódicamente: se reabre sola mientras
      // sigamos en escucha (nunca durante la respuesta, para no transcribir
      // la voz de OE AI por los altavoces).
      if (webSpeechActiveRef.current && !mutedRef.current && phaseRef.current === 'listening') {
        setTimeout(() => {
          if (webSpeechActiveRef.current && !mutedRef.current && phaseRef.current === 'listening' && !recAliveRef.current) {
            startRecognitionRef.current()
          }
        }, 250)
      }
    }
    recognitionRef.current = rec
    try {
      rec.start()
      webSpeechActiveRef.current = true
      recAliveRef.current = true
      socketRef.current?.emit('voice:dictation', { active: true })
      return true
    } catch {
      recAliveRef.current = false
      return false
    }
  }, [armSilenceTimer, stopSilenceTimer])

  useEffect(() => {
    startRecognitionRef.current = startRecognition
  }, [startRecognition])

  /** Silencia el reconocimiento mientras OE AI habla (evita eco). */
  const pauseRecognition = useCallback(() => {
    try {
      recognitionRef.current?.abort()
    } catch {
      /* noop */
    }
  }, [])

  /** Reanuda el reconocimiento al volver a escucha (si usa Web Speech). */
  const ensureRecognition = useCallback(() => {
    if (!webSpeechActiveRef.current || mutedRef.current) return
    if (phaseRef.current !== 'listening' || recAliveRef.current) return
    startRecognition()
  }, [startRecognition])

  /** Último recurso: síntesis local del navegador si ningún proveedor sonó. */
  const speakLocalFallback = useCallback(
    (text: string) => {
      try {
        const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
        if (!synth || !text.trim()) return
        if (localFallbackTimer.current) {
          clearTimeout(localFallbackTimer.current)
          localFallbackTimer.current = null
        }
        if (localSpeakingRef.current) return // ya está hablando la voz local
        const u = new SpeechSynthesisUtterance(text.slice(0, 800))
        u.lang = spanishLocale()
        const voices = synth.getVoices()
        const esVoice = voices.find((v) => v.lang === u.lang) ?? voices.find((v) => v.lang.startsWith('es'))
        if (esVoice) u.voice = esVoice
        u.rate = 1.02
        const endLocal = () => {
          localSpeakingRef.current = false
          if (phaseRef.current === 'speaking' && liveSources.current.length === 0 && awaitingTts.current <= 0) {
            setPhaseSafe('listening')
            ensureRecognition()
          }
        }
        u.onend = endLocal
        u.onerror = endLocal
        localSpeakingRef.current = true
        setPhaseSafe('speaking')
        synth.cancel()
        synth.speak(u)
      } catch {
        localSpeakingRef.current = false
        /* sin síntesis local disponible */
      }
    },
    [ensureRecognition, setPhaseSafe],
  )

  const clearPlayback = useCallback(() => {
    if (localFallbackTimer.current) {
      clearTimeout(localFallbackTimer.current)
      localFallbackTimer.current = null
    }
    localSpeakingRef.current = false
    for (const src of liveSources.current) {
      try {
        src.onended = null
        src.stop()
      } catch {
        /* ya detenido */
      }
    }
    liveSources.current = []
    pendingTts.current.clear()
    awaitingTts.current = 0
    nextSid.current = 0
    chainEnd.current = 0
    llmDone.current = false
    try {
      window.speechSynthesis?.cancel() // corta también la síntesis local
    } catch {
      /* noop */
    }
  }, [])

  /** Programa una frase decodificada de forma continua (sin huecos). */
  const scheduleBuffer = useCallback(
    (buffer: AudioBuffer) => {
      const ctx = ctxRef.current
      if (!ctx) return
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime + 0.04, chainEnd.current + 0.02)
      source.start(startAt)
      chainEnd.current = startAt + buffer.duration
      liveSources.current.push(source)
      source.onended = () => {
        liveSources.current = liveSources.current.filter((s) => s !== source)
        if (liveSources.current.length === 0 && awaitingTts.current <= 0 && llmDone.current && phaseRef.current === 'speaking') {
          setPhaseSafe('listening')
          ensureRecognition() // vuelve a escuchar cuando OE AI termina de hablar
        }
      }
    },
    [ensureRecognition, setPhaseSafe],
  )

  /** Acumula chunks TTS y reproduce cada frase al completarse (en orden). */
  const handleTtsChunk = useCallback(
    (data: TtsChunkEvent) => {
      if (data.turnId < turnRef.current) return
      const ctx = ctxRef.current
      if (!ctx) return
      if (!ttsAudioThisTurn.current) {
        ttsAudioThisTurn.current = true
        // UNA SOLA VOZ: si la síntesis local estaba sonando (respaldo que
        // entró antes de que llegara el audio premium), se corta AHORA.
        if (localSpeakingRef.current) {
          localSpeakingRef.current = false
          try {
            window.speechSynthesis?.cancel()
          } catch {
            /* noop */
          }
        }
        if (localFallbackTimer.current) {
          clearTimeout(localFallbackTimer.current)
          localFallbackTimer.current = null
        }
        pauseRecognition() // el navegador deja de escuchar en cuánto hay voz
      }
      let entry = pendingTts.current.get(data.sid)
      if (!entry) {
        entry = { mime: data.mime, chunks: [] }
        pendingTts.current.set(data.sid, entry)
        awaitingTts.current += 1
      }
      entry.chunks.push(new Uint8Array(atob(data.b64).split('').map((c) => c.charCodeAt(0))))
    },
    [pauseRecognition],
  )

  const handleTtsSentence = useCallback(
    (data: TtsSentenceEvent) => {
      if (data.turnId < turnRef.current) return
      const ctx = ctxRef.current
      const entry = pendingTts.current.get(data.sid)
      pendingTts.current.delete(data.sid)
      if (!ctx || !entry || entry.chunks.length === 0) {
        awaitingTts.current = Math.max(0, awaitingTts.current - 1)
        return
      }
      const total = entry.chunks.reduce((n, c) => n + c.length, 0)
      const bytes = new Uint8Array(total)
      let off = 0
      for (const c of entry.chunks) {
        bytes.set(c, off)
        off += c.length
      }
      const copy = new ArrayBuffer(bytes.length)
      new Uint8Array(copy).set(bytes)
      void ctx
        .decodeAudioData(copy)
        .then((buffer) => {
          if (phaseRef.current !== 'error') {
            setPhaseSafe('speaking')
            pauseRecognition() // mientras OE AI habla, el navegador no escucha
            scheduleBuffer(buffer)
          }
        })
        .catch(() => {
          // frase indecifrable: continúa la cola
        })
        .finally(() => {
          awaitingTts.current = Math.max(0, awaitingTts.current - 1)
        })
    },
    [pauseRecognition, scheduleBuffer],
  )

  const teardownAudio = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    try {
      processorRef.current?.disconnect()
      sourceRef.current?.disconnect()
    } catch {
      /* noop */
    }
    processorRef.current = null
    sourceRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void ctxRef.current?.close().catch(() => undefined)
    ctxRef.current = null
    setLevel(0)
  }, [])

  /** Captura de micrófono: PCM16 → chunks ~100 ms → WebSocket (Scribe/ASR). */
  const startMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    streamRef.current = stream
    // Tasa NATIVA (ver nota del bug de Chrome arriba); el remuestreo a 16 kHz
    // ocurre en onaudioprocess antes de emitir cada chunk.
    const ctx = new AudioContext()
    ctxRef.current = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    const actualRate = ctx.sampleRate
    micWarnedRef.current = false
    silentSinceRef.current = null

    const source = ctx.createMediaStreamSource(stream)
    sourceRef.current = source
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    processorRef.current = processor

    let acc: Float32Array[] = []
    let accLen = 0

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      // Resampleo simple al target de 16 kHz si el contexto difiere.
      let samples = input
      if (Math.abs(actualRate - 16_000) > 1) {
        const ratio = actualRate / 16_000
        const outLen = Math.floor(input.length / ratio)
        const out = new Float32Array(outLen)
        for (let i = 0; i < outLen; i++) {
          const from = Math.floor(i * ratio)
          const to = Math.min(input.length, Math.floor((i + 1) * ratio))
          let sum = 0
          for (let j = from; j < to; j++) sum += input[j]
          out[i] = sum / Math.max(1, to - from)
        }
        samples = out
      }
      acc.push(samples)
      accLen += samples.length
      if (accLen < CHUNK_SAMPLES) return

      const merged = new Float32Array(accLen)
      let off = 0
      for (const part of acc) {
        merged.set(part, off)
        off += part.length
      }
      acc = []
      accLen = 0

      // RMS del chunk (nivel de voz real).
      let sumSq = 0
      for (let i = 0; i < merged.length; i++) sumSq += merged[i] * merged[i]
      const rms = Math.sqrt(sumSq / merged.length)

      if (mutedRef.current || !socketRef.current?.connected) return
      // El audio SIEMPRE fluye al servicio de voz: con Web Speech activo solo
      // se envía en escucha (el servidor lo bufferiza para Scribe); sin Web
      // Speech se envía siempre (el VAD del servidor detecta la frase y el
      // barge-in). Así la transcripción final es SIEMPRE la de élite.
      if (webSpeechActiveRef.current && phaseRef.current !== 'listening') return
      const pcm = new Int16Array(merged.length)
      for (let i = 0; i < merged.length; i++) {
        const s = Math.max(-1, Math.min(1, merged[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      const b64 = arrayBufferToBase64(pcm.buffer)
      socketRef.current.emit('voice:audio', { b64, rms })
    }
    source.connect(processor)
    // El procesador requiere ir a destino para correr; su salida es silencio.
    processor.connect(ctx.destination)

    // Nivel en vivo para el orbe (analyser independiente del envío).
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const levelData = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      if (mutedRef.current) {
        // Silenciado: el orbe no reacciona a la voz (el micrófono no se envía).
        setLevel(0)
        silentSinceRef.current = null
      } else {
        analyser.getByteTimeDomainData(levelData)
        let sumSq = 0
        for (let i = 0; i < levelData.length; i++) {
          const v = (levelData[i] - 128) / 128
          sumSq += v * v
        }
        const rms = Math.sqrt(sumSq / levelData.length)
        setLevel(Math.min(1, rms * 6))
        // Micrófono mudo: si en escucha activa no llega NINGÚN nivel de audio
        // durante varios segundos, el usuario merece saberlo (antes se quedaba
        // en "Escuchando…" para siempre sin entender por qué no responde).
        if (rms < 0.0012) {
          silentSinceRef.current ??= performance.now()
          if (!micWarnedRef.current && phaseRef.current === 'listening' && performance.now() - silentSinceRef.current > 4_000) {
            micWarnedRef.current = true
            setNotice(
              'No estoy recibiendo audio de tu micrófono. Revisa que el dispositivo correcto esté activo y los permisos del navegador.',
            )
          }
        } else {
          if (micWarnedRef.current) {
            micWarnedRef.current = false
            setNotice(null)
          }
          silentSinceRef.current = null
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const start = useCallback(
    async (sessionId: string | null) => {
      if (phaseRef.current !== 'idle' && phaseRef.current !== 'error') return
      setError(null)
      setNotice(null)
      setTranscript('')
      setReply('')
      setTurns([])
      setPhaseSafe('connecting')
      sessionIdRef.current = sessionId
      turnRef.current = 0
      // Estado limpio de dictado y reconocimiento.
      finalTextRef.current = ''
      stopSilenceTimer()
      ttsAudioThisTurn.current = false
      localSpeakingRef.current = false
      webSpeechActiveRef.current = false
      recAliveRef.current = false
      try {
        recognitionRef.current?.abort()
      } catch {
        /* noop */
      }
      recognitionRef.current = null
      try {
        await startMic()
      } catch {
        setPhaseSafe('error')
        setError(
          'No se pudo acceder al micrófono. Revisa los permisos del navegador (candado en la barra de direcciones) e inténtalo de nuevo.',
        )
        teardownAudio()
        return
      }

      const token = await auth.getAccessToken().catch(() => null)
      // Ajustes de voz del usuario leídos AHORA (así un cambio en ajustes se
      // aplica en la siguiente sesión de voz sin recargar): voz, velocidad e
      // intérprete viajan en voice:start y gobiernan TODO el pipeline.
      const settings = readOeSettings()
      setVoiceName(settings.voiceName || 'Sarah')
      setTranslatorTarget(settings.translatorTarget)
      const socket = io(GATEWAY_URL, {
        transports: ['websocket', 'polling'],
        // Envía cookies (oe_guest) también por el transporte polling del gateway.
        withCredentials: true,
        forceNew: true,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 10_000,
        auth: { token: token ?? undefined, sessionId: sessionId ?? undefined },
      })
      socketRef.current = socket

      socket.on('connect', () => {
        // IMPORTANTE: se anuncia la tasa del FORMATO EN EL CABLE (los chunks
        // siempre viajan remuestreados a 16 kHz), no la tasa del contexto de
        // audio local: si no, el servidor envolvería el PCM en WAV con la
        // cabecera equivocada y el ASR escucharía audio acelerado.
        socket.emit('voice:start', {
          sampleRate: WIRE_RATE,
          voiceId: settings.voiceId,
          speed: settings.speed,
          translatorTarget: settings.translatorTarget,
        })
        setPhaseSafe('listening')
        // Web Speech API: subtítulos provisionales gratis y en vivo. Si no
        // existe (Firefox) o su servicio falla, el audio ya fluye al servidor
        // y Scribe/VAD transcribe con la misma calidad.
        if (!startRecognition()) {
          webSpeechActiveRef.current = false
          socket.emit('voice:dictation', { active: false })
        }
      })
      socket.on('connect_error', () => {
        if (phaseRef.current === 'connecting') {
          setPhaseSafe('error')
          setError('No se pudo conectar con el servicio de voz. Inténtalo de nuevo en unos segundos.')
        }
      })
      socket.on('voice:status', (data: StatusEvent) => {
        if (data.phase === 'listening') {
          if (phaseRef.current !== 'idle') {
            setPhaseSafe('listening')
            ensureRecognition()
          }
        } else if (data.phase === 'transcribing') {
          setPhaseSafe('transcribing')
        } else if (data.phase === 'thinking') {
          clearPlayback()
          ttsAudioThisTurn.current = false
          setPhaseSafe('thinking')
        }
      })
      socket.on('voice:user-transcript', (data: TranscriptEvent) => {
        turnRef.current = data.turnId
        setTranscript(data.text) // la transcripción Scribe corrige la provisional
        pushTurn('user', data.text)
      })
      socket.on('voice:assistant-delta', (data: DeltaEvent) => {
        if (data.turnId < turnRef.current) return
        setReply((prev) => prev + data.text)
      })
      socket.on('voice:tts-chunk', handleTtsChunk)
      socket.on('voice:tts-sentence', handleTtsSentence)
      socket.on('voice:assistant-done', (data: DoneEvent) => {
        llmDone.current = true
        if (data.text) {
          setReply((r) => {
            const live = (r + '').trim()
            if (live) pushTurn('ai', live) // guarda la respuesta en los subtítulos
            return ''
          })
        }
        if (liveSources.current.length === 0 && awaitingTts.current <= 0 && phaseRef.current !== 'error') {
          if (!ttsAudioThisTurn.current && data.text) {
            // Margen de gracia: los proveedores premium pueden tardar unos
            // instantes más que el texto. Solo si NADA suena en este margen
            // entra la voz local del navegador (nunca solapada).
            if (localFallbackTimer.current) clearTimeout(localFallbackTimer.current)
            localFallbackTimer.current = setTimeout(() => {
              localFallbackTimer.current = null
              if (!ttsAudioThisTurn.current && !localSpeakingRef.current && liveSources.current.length === 0 && awaitingTts.current <= 0) {
                speakLocalFallback(data.text ?? '')
              }
            }, LOCAL_FALLBACK_GRACE_MS)
          } else {
            setPhaseSafe('listening')
            ensureRecognition()
          }
        }
        const sid = sessionIdRef.current
        if (sid) onTurnComplete?.(sid)
      })
      socket.on('voice:no-audio', (data: NoAudioEvent) => {
        if (data.turnId < turnRef.current) return
        // Señal precisa del servidor: ningún proveedor de voz sonó en el
        // turno → la voz local del navegador narra la respuesta completa.
        if (!ttsAudioThisTurn.current && !localSpeakingRef.current && data.text) {
          if (localFallbackTimer.current) {
            clearTimeout(localFallbackTimer.current)
            localFallbackTimer.current = null
          }
          speakLocalFallback(data.text)
        }
      })
      socket.on('voice:notice', (data: NoticeEvent) => {
        if (data.turnId < turnRef.current) return
        setNotice(data.message)
        if (phaseRef.current !== 'idle') setPhaseSafe('listening')
      })
      socket.on('voice:error', (data: ErrorEvent) => {
        clearPlayback()
        setError(data.message)
        finalTextRef.current = ''
        stopSilenceTimer()
        if (data.errorType === 'guest_limit_reached') {
          setPhaseSafe('error')
          socketRef.current?.disconnect()
          socketRef.current = null
          teardownAudio()
        } else if (phaseRef.current !== 'idle') {
          setPhaseSafe('listening')
          ensureRecognition()
        }
      })
    },
    [
      auth,
      clearPlayback,
      ensureRecognition,
      handleTtsChunk,
      handleTtsSentence,
      onTurnComplete,
      pushTurn,
      speakLocalFallback,
      startMic,
      startRecognition,
      stopSilenceTimer,
      teardownAudio,
    ],
  )

  const interrupt = useCallback(() => {
    clearPlayback()
    socketRef.current?.emit('voice:interrupt')
    setReply((r) => {
      const live = (r + '').trim()
      if (live) pushTurn('ai', live) // la respuesta cortada queda en subtítulos
      return ''
    })
    finalTextRef.current = ''
    stopSilenceTimer()
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'error') setPhaseSafe('listening')
    ensureRecognition()
  }, [clearPlayback, ensureRecognition, pushTurn, stopSilenceTimer])

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    socketRef.current?.emit('voice:mute', { muted: next })
    if (next) {
      // MUTE TOTAL: el navegador deja de escuchar de inmediato y se descarta
      // lo dictado a medias; el servidor también ignora el audio en curso.
      try {
        recognitionRef.current?.abort()
      } catch {
        /* noop */
      }
      finalTextRef.current = ''
      stopSilenceTimer()
    } else {
      ensureRecognition()
    }
  }, [ensureRecognition, stopSilenceTimer])

  const stop = useCallback(() => {
    socketRef.current?.emit('voice:end')
    socketRef.current?.disconnect()
    socketRef.current = null
    clearPlayback()
    teardownAudio()
    try {
      recognitionRef.current?.abort()
    } catch {
      /* noop */
    }
    recognitionRef.current = null
    webSpeechActiveRef.current = false
    recAliveRef.current = false
    finalTextRef.current = ''
    stopSilenceTimer()
    ttsAudioThisTurn.current = false
    mutedRef.current = false
    setMuted(false)
    phaseRef.current = 'idle'
    setPhase('idle')
    setNotice(null)
    setVoiceName('')
    setTranslatorTarget('')
    micWarnedRef.current = false
    silentSinceRef.current = null
  }, [clearPlayback, stopSilenceTimer, teardownAudio])

  // Limpieza al desmontar.
  useEffect(() => {
    return () => {
      socketRef.current?.disconnect()
      try {
        recognitionRef.current?.abort()
      } catch {
        /* noop */
      }
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
      try {
        window.speechSynthesis?.cancel()
      } catch {
        /* noop */
      }
      teardownAudio()
    }
  }, [stopSilenceTimer, teardownAudio])

  return {
    phase,
    muted,
    level,
    transcript,
    reply,
    turns,
    notice,
    error,
    voiceName,
    translatorTarget,
    start,
    stop,
    interrupt,
    toggleMute,
    active: phase !== 'idle',
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
