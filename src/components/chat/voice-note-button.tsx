'use client'

/**
 * VoiceNoteButton — nota de voz del chat escrito (componente AUTOCONTENIDO).
 *
 * Pulsar para grabar con el micrófono (MediaRecorder, audio/webm si existe);
 * pulsar de nuevo para parar: el audio se convierte en data URL, se transcribe
 * con POST /api/tools/asr y el texto resultante se entrega vía
 * onTranscribed(text) para que el composer lo coloque donde prefiera
 * (normalmente dentro del input, listo para editar y enviar).
 *
 * Sin dependencias nuevas: React + lucide-react + sonner (ya en el proyecto).
 * No depende de nada del chat: el composer lo importa y le pasa el callback.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Square } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface VoiceNoteButtonProps {
  /** Recibe el texto transcrito (recortado, listo para el input). */
  onTranscribed: (text: string) => void
  /** Deshabilita el botón (p. ej. mientras se envía el formulario). */
  disabled?: boolean
}

/** Primer mime soportado por MediaRecorder (webm preferido; mp4 en Safari). */
function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    } catch {
      // navegador sin isTypeSupported: prueba el siguiente candidato
    }
  }
  return undefined
}

/** 'audio/webm;codecs=opus' → 'audio/webm' (prefijo exigido por el API ASR). */
function normalizedMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  return base === 'audio/x-webm' ? 'audio/webm' : base || 'audio/webm'
}

/** Blob → base64 crudo (sin el prefijo data:, que se reconstruye normalizado). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      if (comma < 0) {
        reject(new Error('audio ilegible'))
        return
      }
      resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('audio ilegible'))
    reader.readAsDataURL(blob)
  })
}

const MAX_MS = 120_000 // cota de seguridad: 2 minutos por nota de voz

export function VoiceNoteButton({ onTranscribed, disabled = false }: VoiceNoteButtonProps) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false) // transcribiendo en el servidor
  const [elapsedMs, setElapsedMs] = useState(0)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef(0)
  const mimeRef = useRef('')
  const cancelledRef = useRef(false)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  /** Segunda pulsación: corta la grabación y transcribe lo capturado. */
  const stopAndTranscribe = useCallback(() => {
    clearTimer()
    setRecording(false)
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    setBusy(true)
    recorder.stop() // el procesamiento continúa en onstop
  }, [clearTimer])

  const startRecording = useCallback(async () => {
    if (disabled || busy || recording) return
    cancelledRef.current = false
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      toast.error('No pude acceder al micrófono')
      return
    }
    if (typeof MediaRecorder === 'undefined') {
      releaseMic()
      toast.error('Tu navegador no soporta grabar audio')
      return
    }
    const mime = pickRecorderMime()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    } catch {
      releaseMic()
      toast.error('Tu navegador no soporta grabar audio')
      return
    }
    streamRef.current = stream
    mimeRef.current = mime ?? ''
    chunksRef.current = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      releaseMic()
      recorderRef.current = null
      if (cancelledRef.current) {
        setBusy(false)
        return
      }
      void (async () => {
        try {
          // Mime NORMALIZADO en el data URL: /api/tools/asr valida el prefijo
          // data:audio/(webm|wav|x-wav|mp4) y 'audio/webm;codecs=opus' (el tipo
          // real del blob) no pasaría esa validación.
          const type = normalizedMime(chunksRef.current[0]?.type || mimeRef.current || 'audio/webm')
          const blob = new Blob(chunksRef.current, { type })
          chunksRef.current = []
          if (blob.size < 1200) {
            toast.error('No entendí el audio, inténtalo de nuevo')
            return
          }
          const b64 = await blobToBase64(blob)
          const res = await fetch('/api/tools/asr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: `data:${type};base64,${b64}` }),
          })
          const data = (await res.json().catch(() => null)) as { text?: string; error?: string } | null
          const text = data?.text?.trim()
          if (!res.ok || !text) {
            toast.error(data?.error || 'No entendí el audio, inténtalo de nuevo')
            return
          }
          onTranscribed(text)
        } catch {
          toast.error('No entendí el audio, inténtalo de nuevo')
        } finally {
          setBusy(false)
        }
      })()
    }
    recorderRef.current = recorder
    recorder.start()
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setRecording(true)
    clearTimer()
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      if (elapsed >= MAX_MS) stopAndTranscribe() // cota de seguridad
    }, 250)
  }, [busy, clearTimer, disabled, onTranscribed, recording, releaseMic, stopAndTranscribe])

  // Limpieza total al desmontar: corta temporizador, grabadora y micrófono sin
  // procesar nada a medias (cancelledRef evita toasts/callbacks póstumos).
  useEffect(() => {
    return () => {
      cancelledRef.current = true
      clearTimer()
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          /* ya detenido */
        }
      }
      releaseMic()
    }
  }, [clearTimer, releaseMic])

  const totalSeconds = Math.floor(elapsedMs / 1000)
  const timer = `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`
  const idleLabel = 'Mensaje de voz (transcribe automáticamente)'
  const label = recording ? 'Detener grabación' : idleLabel

  return (
    <div className="flex items-center gap-1.5">
      {recording && (
        <span
          className="rounded-full bg-red-500/10 px-2 py-0.5 font-mono text-xs tabular-nums text-red-500"
          role="timer"
          aria-label={`Grabando, ${timer} transcurridos`}
        >
          {timer}
        </span>
      )}
      <button
        type="button"
        onClick={recording ? stopAndTranscribe : () => void startRecording()}
        disabled={busy || (disabled && !recording)}
        aria-label={label}
        aria-pressed={recording}
        title={label}
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-full border transition-all hover:scale-105 disabled:pointer-events-none disabled:opacity-50',
          recording
            ? 'border-red-500/40 bg-red-500/10 text-red-500 hover:bg-red-500/15'
            : 'border-border/60 bg-secondary/40 text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {busy ? (
          <Loader2 className="size-[18px] animate-spin" aria-hidden />
        ) : recording ? (
          <Square className="size-4 animate-pulse fill-current" aria-hidden />
        ) : (
          <Mic className="size-[18px]" aria-hidden />
        )}
      </button>
    </div>
  )
}
