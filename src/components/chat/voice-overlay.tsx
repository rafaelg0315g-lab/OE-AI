'use client'

/**
 * VoiceOverlay — Modo Voz de OE AI LLM (pantalla completa).
 *
 * Diseño minimalista tipo sala de conferencia:
 *  · Subtítulos limpios con historial de turnos (sin burbujas): etiqueta
 *    pequeña de quien habla + texto grande y legible, auto-scroll suave.
 *  · Orbe premium en canvas (VoiceOrb) con anillo reactivo al micrófono.
 *  · Controles: silenciar / colgar / empezar. Tocar el orbe interrumpe.
 * Cada turno se guarda en la conversación real del chat: al cerrar, el
 * historial ya está sincronizado.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, AudioLines, Mic, MicOff, PhoneOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translatorLangName } from '@/lib/voices'
import { useAuth } from '@/components/auth/auth-provider'
import { useChat } from './chat-context'
import { useVoiceMode, type VoicePhase } from '@/hooks/use-voice-mode'
import { VoiceOrb } from './voice-orb'

const PHASE_LABEL: Record<VoicePhase, { title: string; hint: string }> = {
  idle: { title: 'Modo voz', hint: 'Pulsa el micrófono para empezar' },
  connecting: { title: 'Conectando…', hint: 'Abriendo el micrófono y el canal de voz' },
  listening: { title: 'Escuchando…', hint: 'Habla con naturalidad; respondo cuando hagas 2 s de silencio' },
  transcribing: { title: 'Transcribiendo…', hint: 'Pasando tu voz a texto con máxima precisión' },
  thinking: { title: 'Pensando…', hint: 'OE AI LLM está procesando tu pregunta' },
  speaking: { title: 'Hablando…', hint: 'Toca el orbe para interrumpir cuando quieras' },
  error: { title: 'Algo salió mal', hint: 'Revisa el mensaje y vuelve a intentarlo' },
}

/** Línea de subtítulo de un turno cerrado. */
function SubtitleLine({ who, text }: { who: 'user' | 'ai'; text: string }) {
  const isAi = who === 'ai'
  return (
    <div className={cn('flex flex-col gap-1', isAi ? 'items-start' : 'items-end')}>
      <span
        className={cn(
          'text-[10px] font-semibold uppercase tracking-[0.22em]',
          isAi ? 'text-emerald-300/80' : 'text-white/30',
        )}
      >
        {isAi ? 'OE AI' : 'Tú'}
      </span>
      <p
        className={cn(
          'max-w-full text-balance leading-relaxed',
          isAi ? 'text-left text-lg text-white/95' : 'text-right text-[15px] text-white/55',
        )}
      >
        {text}
      </p>
    </div>
  )
}

export function VoiceOverlay() {
  const chat = useChat()
  const { user } = useAuth()
  const [visible, setVisible] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const syncTurn = useCallback(
    (sessionId: string) => {
      // Cada turno de voz vive en la conversación real del chat.
      void chat.refreshQuota()
      void chat.refreshConversations()
      if (chat.activeId !== sessionId) void chat.loadConversation(sessionId)
    },
    [chat],
  )

  const voice = useVoiceMode({ onTurnComplete: syncTurn })

  // Abrir/cerrar desde cualquier parte de la UI (composer, atajos).
  // La cuota de invitado SOLO bloquea a quien no ha iniciado sesión:
  // los usuarios verificados tienen voz ilimitada.
  useEffect(() => {
    const open = () => {
      if (chat.guestBlocked && !user) return
      setVisible(true)
    }
    window.addEventListener('oe-open-voice', open)
    return () => window.removeEventListener('oe-open-voice', open)
  }, [chat.guestBlocked, user])

  const close = useCallback(() => {
    voice.stop()
    setVisible(false)
    // Refresco final por si el último turno terminó justo al colgar.
    const sid = sessionIdRef.current
    if (sid) syncTurn(sid)
  }, [syncTurn, voice])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, close])

  function openVoiceSession() {
    const sid = chat.activeId ?? (sessionIdRef.current ??= crypto.randomUUID())
    sessionIdRef.current = sid
    voice.start(sid)
  }

  // Auto-scroll de los subtítulos: siempre la última palabra a la vista.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [voice.turns, voice.reply, voice.transcript, visible])

  const label =
    voice.muted && voice.phase === 'listening'
      ? { title: 'Silenciado', hint: 'Tu voz no se escucha; pulsa el micrófono para volver a hablar' }
      : PHASE_LABEL[voice.phase]
  const isListening = voice.phase === 'listening'
  const isSpeaking = voice.phase === 'speaking'
  const hasContent = voice.turns.length > 0 || Boolean(voice.transcript) || Boolean(voice.reply)

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          role="dialog"
          aria-modal="true"
          aria-label="Modo voz de OE AI LLM"
          className="fixed inset-0 z-[70] flex flex-col bg-[radial-gradient(110%_80%_at_50%_-10%,oklch(0.20_0.035_170)_0%,oklch(0.11_0.02_170)_48%,oklch(0.07_0.012_170)_100%)] text-foreground"
        >
          {/* Cabecera minimalista */}
          <header className="flex items-center justify-between px-5 py-4 sm:px-8">
            <div className="flex items-center gap-2 text-white/50">
              <AudioLines className="size-4" aria-hidden />
              <span className="text-xs font-medium tracking-wide">OE AI · Modo voz</span>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Cerrar modo voz"
              className="grid size-9 place-items-center rounded-full border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/10 hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>

          {/* Subtítulos minimalistas */}
          <div
            ref={scrollRef}
            className="scrollbar-slim mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-5 [mask-image:linear-gradient(to_bottom,transparent,black_28px)] sm:px-8"
            aria-live="polite"
          >
            <div className="flex min-h-full flex-col justify-end gap-5 pb-6 pt-10">
              {voice.turns.map((turn, i) => (
                <SubtitleLine key={`${turn.who}-${i}`} who={turn.who} text={turn.text} />
              ))}

              {/* Dictado provisional en vivo (antes de la transcripción exacta) */}
              {voice.transcript && (
                <div className="flex flex-col items-end gap-1">
                  <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-white/30">
                    <motion.span
                      aria-hidden
                      animate={{ opacity: [0.25, 1, 0.25] }}
                      transition={{ duration: 1.4, repeat: Infinity }}
                      className="size-1.5 rounded-full bg-emerald-400"
                    />
                    Tú
                  </span>
                  <p className="max-w-full text-right text-[15px] leading-relaxed text-white/75">{voice.transcript}</p>
                </div>
              )}

              {/* Respuesta en streaming con cursor */}
              {voice.reply && (
                <div className="flex flex-col items-start gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-300/80">OE AI</span>
                  <p className="max-w-full text-lg leading-relaxed text-white/95">
                    {voice.reply}
                    <span className="ml-0.5 inline-block h-5 w-[2px] translate-y-[3px] animate-pulse bg-emerald-300/80" aria-hidden />
                  </p>
                </div>
              )}

              {!hasContent && voice.phase !== 'error' && (
                <p className="self-center text-center text-sm text-white/30">
                  {voice.phase === 'idle' ? 'Pulsa el micrófono y habla' : 'Los subtítulos de la conversación aparecerán aquí'}
                </p>
              )}
            </div>
          </div>

          {/* Orbe, estado y controles */}
          <div className="flex flex-col items-center gap-4 px-5 pb-8 pt-3 sm:pb-10">
            <motion.button
              type="button"
              onClick={isSpeaking ? voice.interrupt : undefined}
              disabled={!isSpeaking}
              aria-label={isSpeaking ? 'Interrumpir la respuesta' : undefined}
              animate={{ scale: 1 + (isListening || isSpeaking ? voice.level * 0.08 : 0) }}
              transition={{ type: 'spring', stiffness: 180, damping: 16 }}
              className={cn(
                'relative size-64 sm:size-72',
                isSpeaking ? 'cursor-pointer' : 'cursor-default',
              )}
            >
              <VoiceOrb phase={voice.phase} level={voice.level} muted={voice.muted} className="size-full" />
            </motion.button>

            <div className="text-center" role="status">
              <p className="text-base font-semibold text-white/90">{label.title}</p>
              <p className="mt-0.5 text-xs text-white/45">{label.hint}</p>
            </div>

            {/* Voz activa e intérprete (discreto; aparece al iniciar la sesión) */}
            {(voice.voiceName || voice.translatorTarget) && (
              <div className="flex items-center justify-center gap-2 text-[11px] text-white/40">
                {voice.voiceName && (
                  <span>
                    Voz: <span className="text-white/60">{voice.voiceName}</span>
                  </span>
                )}
                {voice.voiceName && voice.translatorTarget && <span aria-hidden>·</span>}
                {voice.translatorTarget && (
                  <span className="rounded-full bg-emerald-400/10 px-2.5 py-0.5 text-[10px] font-medium text-emerald-200 ring-1 ring-emerald-300/25">
                    Traduciendo → {translatorLangName(voice.translatorTarget)}
                  </span>
                )}
              </div>
            )}

            {voice.notice && !voice.error && (
              <p
                className="max-w-md rounded-full bg-amber-400/10 px-4 py-1.5 text-center text-xs text-amber-200 ring-1 ring-amber-300/20"
                role="status"
              >
                {voice.notice}
              </p>
            )}

            {voice.error && (
              <div
                className="mx-auto flex max-w-md items-start gap-2.5 rounded-xl bg-red-500/10 px-4 py-3 text-left text-xs leading-relaxed text-red-200 ring-1 ring-red-400/25"
                role="alert"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="flex flex-col gap-2">
                  <span>{voice.error}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 w-fit gap-1.5 border-white/20 bg-white/5 text-white hover:bg-white/10"
                    onClick={() => {
                      voice.stop()
                      openVoiceSession()
                    }}
                  >
                    <Mic className="size-3.5" aria-hidden />
                    Intentar de nuevo
                  </Button>
                </div>
              </div>
            )}

            {/* Controles inferiores */}
            <div className="flex items-center gap-5">
              <button
                type="button"
                onClick={voice.toggleMute}
                aria-pressed={voice.muted}
                aria-label={voice.muted ? 'Activar micrófono' : 'Silenciar micrófono'}
                title={voice.muted ? 'Activar micrófono' : 'Silenciar micrófono'}
                className={cn(
                  'grid size-12 place-items-center rounded-full border transition-all hover:scale-105',
                  voice.muted
                    ? 'border-amber-300/40 bg-amber-400/15 text-amber-200'
                    : 'border-white/12 bg-white/5 text-white/75 hover:bg-white/10',
                )}
              >
                {voice.muted ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
              </button>

              {voice.active ? (
                <button
                  type="button"
                  onClick={close}
                  aria-label="Colgar y cerrar el modo voz"
                  title="Colgar"
                  className="grid size-16 place-items-center rounded-full bg-red-500 text-white shadow-[0_10px_40px_-8px_oklch(0.62_0.22_25/0.7)] transition-all hover:scale-105 hover:bg-red-400"
                >
                  <PhoneOff className="size-6" aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={openVoiceSession}
                  aria-label="Empezar a hablar"
                  title="Empezar a hablar"
                  disabled={voice.phase === 'connecting'}
                  className="grid size-16 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 shadow-[0_10px_40px_-8px_oklch(0.78_0.14_168/0.7)] transition-all hover:scale-105 disabled:opacity-60"
                >
                  <Mic className="size-6" aria-hidden />
                </button>
              )}

              <div className="grid size-12 place-items-center" aria-hidden>
                {isSpeaking && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 0.7, 0] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="text-[10px] font-medium text-white/50"
                  >
                    interrumpir
                  </motion.span>
                )}
              </div>
            </div>

            {!voice.active && voice.phase !== 'error' && (
              <p className="text-center text-[11px] text-white/30">
                Cada turno de voz consume un chat de tu cuota · Escape para salir
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
