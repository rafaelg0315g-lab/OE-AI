'use client'

/**
 * Lista de mensajes del chat premium:
 * - Burbujas del usuario a la derecha, editables (recorta y reenvía).
 * - Respuestas de OE AI LLM con avatar animado, revelación progresiva con
 *   cursor, markdown, fuentes de búsqueda web, lectura en voz alta (TTS)
 *   y acciones (copiar / regenerar / escuchar).
 * - Imágenes generadas por la herramienta del núcleo con descarga y regenerado.
 * - Sugerencias de seguimiento y botón flotante «ir al final».
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  ArrowDown,
  BadgeCheck,
  Check,
  Copy,
  Download,
  Eye,
  Globe,
  Lightbulb,
  ListPlus,
  Pencil,
  RotateCcw,
  Square,
  Waypoints,
  Volume2,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useChat } from './chat-context'
import type { ChatMsg } from '@/hooks/use-oe-chat'
import { CanvasPanel } from './canvas-panel'
import { BuildPendingPlaceholder } from './build-pending-placeholder'
import { BuildLivePanel } from './build-live-panel'
import { ImagePendingPlaceholder } from './image-pending-placeholder'
import { Markdown } from './markdown'
import { OeLogo } from './oe-logo'
import { VideoPendingPlaceholder } from './video-pending-placeholder'

/* ── Lectura en voz alta (una sola reproducción global) ─────────────────── */
let globalAudio: HTMLAudioElement | null = null

type TtsState = 'idle' | 'loading' | 'playing'

function stopGlobalAudio() {
  if (globalAudio) {
    globalAudio.pause()
    globalAudio.src = ''
    globalAudio = null
  }
}

function SpeakButton({ msg }: { msg: ChatMsg }) {
  const [state, setState] = useState<TtsState>('idle')
  const [note, setNote] = useState<string | null>(null)

  // Al desmontar, si este audio es el global activo se detiene.
  useEffect(() => {
    return () => {
      if (globalAudio && globalAudio.dataset.msgId === msg.id) stopGlobalAudio()
    }
  }, [msg.id])

  async function toggle() {
    if (state === 'playing') {
      stopGlobalAudio()
      setState('idle')
      return
    }
    if (state === 'loading') return
    setState('loading')
    setNote(null)
    stopGlobalAudio()
    try {
      const res = await fetch('/api/tools/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: msg.fullContent || msg.content }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error ?? 'No se pudo generar el audio.')
      }
      const blob = await res.blob()
      const audio = new Audio(URL.createObjectURL(blob))
      audio.dataset.msgId = msg.id
      globalAudio = audio
      audio.onended = () => {
        setState('idle')
        if (globalAudio === audio) globalAudio = null
      }
      audio.onerror = () => setState('idle')
      setState('playing')
      void audio.play()
    } catch (err) {
      setState('idle')
      setNote(err instanceof Error ? err.message : 'No se pudo generar el audio.')
    }
  }

  const label =
    state === 'playing'
      ? 'Detener lectura'
      : state === 'loading'
        ? 'Generando audio…'
        : 'Leer en voz alta (voz premium)'

  return (
    <>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={state === 'loading'}
        aria-label={label}
        title={label}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40',
          state === 'playing' ? 'text-emerald-300' : 'text-muted-foreground',
        )}
      >
        {state === 'loading' ? (
          <motion.span
            aria-hidden
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.1, repeat: Infinity }}
            className="inline-flex"
          >
            <Volume2 className="size-3" />
          </motion.span>
        ) : state === 'playing' ? (
          <Square className="size-3 fill-current" aria-hidden />
        ) : (
          <Volume2 className="size-3" aria-hidden />
        )}
        {state === 'playing' ? 'Detener' : 'Escuchar'}
      </button>
      {note && <span className="text-[11px] text-amber-300/90">{note}</span>}
    </>
  )
}

/* ── Lista principal ────────────────────────────────────────────────────── */

const FOLLOW_UPS = [
  { key: 'example', icon: Lightbulb, label: 'Dame un ejemplo práctico' },
  { key: 'simpler', icon: ListPlus, label: 'Explícalo más simple' },
  { key: 'more', icon: ArrowDown, label: 'Profundiza en el tema' },
] as const

export function MessageList() {
  const chat = useChat()
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  /** Código del bloque html abierto en el Canvas (null = cerrado). */
  const [canvasCode, setCanvasCode] = useState<string | null>(null)

  // Auto-scroll inteligente: solo si el usuario está cerca del final
  useEffect(() => {
    const el = bottomRef.current
    if (!el || !stickRef.current) return
    el.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat.messages, chat.phase])

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const target = e.currentTarget
    const distance = target.scrollHeight - target.scrollTop - target.clientHeight
    stickRef.current = distance < 120
    setShowJump(distance > 420)
  }

  const lastMsg = chat.messages[chat.messages.length - 1]
  const showFollowUps =
    !chat.pending && !chat.error && lastMsg?.role === 'assistant' && lastMsg.complete && !lastMsg.pendingImage && !lastMsg.pendingProject

  return (
    <div className="relative min-h-0 flex-1">
      <div
        className="scrollbar-slim mx-auto h-full w-full max-w-3xl overflow-y-auto px-4 pt-6 sm:px-6"
        onScroll={onScroll}
        aria-live="polite"
        aria-label="Conversación con OE AI LLM"
      >
        {chat.loadingHistory && (
          <div className="flex flex-col gap-4 py-6" role="status" aria-label="Cargando conversación">
            {[0, 1, 2].map((i) => (
              <div key={i} className={cn('flex', i % 2 ? 'justify-end' : 'justify-start')}>
                <div className="h-16 w-2/3 animate-pulse rounded-3xl bg-secondary/40" />
              </div>
            ))}
          </div>
        )}

        <ul className="flex flex-col gap-6 pb-4">
          {chat.messages.map((m) => (
            <motion.li
              key={m.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className={cn('flex gap-3', m.role === 'user' && 'justify-end')}
            >
              {m.role === 'assistant' && <AssistantAvatar thinking={!m.complete} />}
              <div className={cn('min-w-0', m.role === 'user' ? 'max-w-[85%]' : 'max-w-full flex-1')}>
                {m.role === 'user' ? (
                  <UserBubble msg={m} />
                ) : (
                  <AssistantContent msg={m} onOpenCanvas={setCanvasCode} />
                )}
              </div>
            </motion.li>
          ))}

          {/* Error honesto del proveedor con reintento */}
          {chat.error && (
            <li>
              <Alert variant="destructive" role="alert" className="rounded-2xl">
                <AlertCircle className="size-4" aria-hidden />
                <AlertTitle>No se pudo completar la respuesta</AlertTitle>
                <AlertDescription className="flex flex-col gap-2 text-xs leading-relaxed">
                  <span>{chat.error.message}</span>
                  {chat.lastUserMsg && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit gap-1.5"
                      onClick={chat.regenerate}
                      disabled={chat.pending}
                    >
                      <RotateCcw className="size-3.5" aria-hidden />
                      Reintentar
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            </li>
          )}

          {/* Sugerencias de seguimiento */}
          <AnimatePresence>
            {showFollowUps && (
              <motion.li
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, delay: 0.15 }}
              >
                <div className="flex flex-wrap items-center gap-2 pl-10" aria-label="Sugerencias de seguimiento">
                  {FOLLOW_UPS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => void chat.send(f.label)}
                      className="flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/30 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-all hover:scale-[1.03] hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-foreground"
                    >
                      <f.icon className="size-3.5 text-emerald-300" aria-hidden />
                      {f.label}
                    </button>
                  ))}
                </div>
              </motion.li>
            )}
          </AnimatePresence>

          <div ref={bottomRef} aria-hidden />
        </ul>
      </div>

      {/* Canvas: vista previa en vivo de bloques html (estilo Artifacts) */}
      <CanvasPanel
        open={canvasCode !== null}
        onOpenChange={(o) => {
          if (!o) setCanvasCode(null)
        }}
        code={canvasCode ?? ''}
      />

      {/* Botón flotante: ir al final */}
      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            onClick={() => {
              stickRef.current = true
              bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
            }}
            aria-label="Ir al final de la conversación"
            className="absolute bottom-4 right-4 z-10 grid size-10 place-items-center rounded-full border border-border/70 bg-background/85 text-muted-foreground shadow-lg backdrop-blur transition-colors hover:text-foreground"
          >
            <ArrowDown className="size-4" aria-hidden />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ── Burbuja del usuario con edición ────────────────────────────────────── */

function UserBubble({ msg }: { msg: ChatMsg }) {
  const chat = useChat()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)

  function save() {
    const text = draft.trim()
    setEditing(false)
    if (!text || text === msg.content) return
    void chat.editMessage(msg.id, text)
  }

  if (editing) {
    return (
      <div className="w-full min-w-[240px] rounded-3xl rounded-br-lg border border-emerald-500/40 bg-secondary/60 p-3">
        <label htmlFor={`edit-${msg.id}`} className="sr-only">
          Editar mensaje
        </label>
        <Textarea
          id={`edit-${msg.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              save()
            }
            if (e.key === 'Escape') setEditing(false)
          }}
          rows={3}
          autoFocus
          className="scrollbar-slim min-h-0 w-full resize-none border-0 bg-transparent px-0 py-0 text-sm leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
          <Button size="sm" className="gap-1.5" onClick={save} disabled={!draft.trim() || chat.pending}>
            <Check className="size-3.5" aria-hidden />
            Guardar y regenerar
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="group/user flex flex-col items-end gap-1">
      {/* Imagen adjuntada por el usuario (turno de visión) */}
      {msg.attachmentUrl && (
        <a
          href={msg.attachmentUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Abrir imagen adjunta en tamaño completo"
          className="block max-w-[85%] overflow-hidden rounded-3xl rounded-br-lg ring-1 ring-border/60 transition-shadow hover:ring-emerald-500/40"
        >
          <img
            src={msg.attachmentUrl}
            alt={msg.content ? `Imagen adjunta: ${msg.content}` : 'Imagen adjunta por el usuario'}
            className="max-h-56 w-auto max-w-full bg-secondary/30"
            loading="lazy"
          />
        </a>
      )}
      {msg.content && (
        <div className="rounded-3xl rounded-br-lg bg-primary/15 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground ring-1 ring-primary/20">
          {msg.content}
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          setDraft(msg.content)
          setEditing(true)
        }}
        disabled={chat.pending}
        aria-label="Editar mensaje y reenviar"
        title="Editar y reenviar"
        className="mr-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/user:opacity-100 disabled:pointer-events-none [@media(pointer:coarse)]:opacity-100"
      >
        <Pencil className="size-3" aria-hidden />
        Editar
      </button>
    </div>
  )
}

/* ── Respuesta del asistente ────────────────────────────────────────────── */

function AssistantAvatar({ thinking }: { thinking: boolean }) {
  return (
    <span className="relative mt-0.5 shrink-0">
      <OeLogo size="sm" animated={thinking} />
      {thinking && (
        <motion.span
          aria-hidden
          className="absolute -inset-1 rounded-[30%] border border-emerald-400/50"
          animate={{ scale: [1, 1.25, 1], opacity: [0.7, 0, 0.7] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
    </span>
  )
}

function AssistantContent({ msg, onOpenCanvas }: { msg: ChatMsg; onOpenCanvas: (code: string) => void }) {
  const chat = useChat()

  // Placeholder "aurora nube" mientras se genera la imagen (etapas SSE + timer).
  if (msg.pendingImage) {
    return (
      <div className="w-full max-w-sm">
        <ImagePendingPlaceholder note={msg.imageStage?.note} elapsed={msg.imageStage?.elapsed} />
      </div>
    )
  }

  // Placeholder "aurora de puntos" mientras se genera el video narrado.
  if (msg.pendingVideo) {
    return (
      <div className="w-full max-w-[270px]">
        <VideoPendingPlaceholder />
      </div>
    )
  }

  // Constructor de apps EN VIVO: tareas marcándose + código streaming + descargas.
  if (msg.build) {
    return (
      <div className="w-full">
        {msg.content && (
          <div className="mb-3 rounded-2xl rounded-tl-lg bg-secondary/50 px-4 py-3 ring-1 ring-border/50">
            <Markdown content={msg.content} onOpenCanvas={onOpenCanvas} />
          </div>
        )}
        <BuildLivePanel build={msg.build} />
      </div>
    )
  }

  // Constructor legacy (sin snapshot, p. ej. reanudado por sondeo): aurora.
  if (msg.pendingProject) {
    return (
      <div className="w-full">
        {msg.content && (
          <div className="rounded-2xl rounded-tl-lg bg-secondary/50 px-4 py-3 ring-1 ring-border/50">
            <Markdown content={msg.content} onOpenCanvas={onOpenCanvas} />
          </div>
        )}
        <div className="mt-3 w-full max-w-md">
          <BuildPendingPlaceholder />
        </div>
      </div>
    )
  }

  if (!msg.content && !msg.fullContent && msg.kind !== 'image') {
    return (
      <div className="flex h-[38px] items-center gap-2.5 rounded-2xl px-1">
        <span className="oe-shimmer text-sm font-medium">
          {chat.webSearching ? 'Buscando en la web' : 'OE AI LLM está pensando'}
        </span>
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="size-1.5 rounded-full bg-emerald-400/80"
              animate={{ y: [0, -4, 0], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
            />
          ))}
        </span>
      </div>
    )
  }

  if (msg.kind === 'image') {
    return <ImageContent msg={msg} />
  }

  return (
    <div className="group/msg">
      <div className="rounded-2xl rounded-tl-lg bg-secondary/50 px-4 py-3 ring-1 ring-border/50">
        {/* Markdown SIEMPRE: el revelado progresivo también se parsea, así las
            tablas, negritas y listas se ven formateadas desde el primer frame
            (sin mostrar nunca la sintaxis cruda). */}
        <div className={cn(!msg.complete && 'oe-caret')}>
          <Markdown content={msg.content} onOpenCanvas={onOpenCanvas} serif />
        </div>
      </div>

      {/* Aviso honesto: la búsqueda web no estuvo disponible */}
      {msg.searchNote && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-300/90" role="status">
          <AlertCircle className="size-3" aria-hidden />
          {msg.searchNote}
        </p>
      )}

      {/* Fuentes web reales usadas para responder */}
      {msg.sources && msg.sources.length > 0 && (
        <div className="mt-2 rounded-xl border border-border/50 bg-secondary/25 px-3 py-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Globe className="size-3 text-emerald-300" aria-hidden />
            Fuentes web ({msg.sources.length})
          </p>
          <ol className="flex flex-col gap-1">
            {msg.sources.map((s, i) => (
              <li key={`${s.url}-${i}`} className="min-w-0 text-xs leading-snug">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-baseline gap-1.5 rounded text-foreground/80 transition-colors hover:text-emerald-300"
                  title={s.snippet || s.name}
                >
                  <span className="font-mono text-[10px] text-muted-foreground">[{i + 1}]</span>
                  <span className="truncate font-medium">{s.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">— {s.hostName}</span>
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Meta: orquestador, latencia, acciones */}
      {msg.complete && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 opacity-70 transition-opacity group-hover/msg:opacity-100">
          <Badge variant="outline" className="gap-1 border-border/60 text-[10px] text-muted-foreground">
            <Waypoints className="size-3 text-emerald-400" aria-hidden />
            {msg.meta?.coreLabel ? `OE AI LLM · Núcleo ${msg.meta.coreLabel}` : 'OE AI LLM'}
          </Badge>
          {msg.meta?.webSearchUsed && (
            <Badge variant="outline" className="gap-1 border-emerald-500/30 text-[10px] text-emerald-300">
              <Globe className="size-3" aria-hidden />
              Búsqueda web
            </Badge>
          )}
          {msg.meta?.visionUsed && (
            <Badge variant="outline" className="gap-1 border-emerald-500/30 text-[10px] text-emerald-300">
              <Eye className="size-3" aria-hidden />
              Visión
            </Badge>
          )}
          {typeof msg.meta?.latencyMs === 'number' && msg.meta.latencyMs > 0 && (
            <Badge variant="outline" className="border-border/60 text-[10px] text-muted-foreground">
              {(msg.meta.latencyMs / 1000).toFixed(1)} s
            </Badge>
          )}
          {msg.meta?.mode === 'reflective' && (
            <Badge variant="outline" className="border-emerald-500/30 text-[10px] text-emerald-300">
              Reflexivo
            </Badge>
          )}
          <CopyTextButton text={msg.fullContent} label="Copiar respuesta" />
          <button
            type="button"
            onClick={chat.regenerate}
            disabled={chat.pending}
            aria-label="Regenerar respuesta"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <RotateCcw className="size-3" aria-hidden />
            Regenerar
          </button>
          <SpeakButton msg={msg} />
        </div>
      )}
    </div>
  )
}

/* ── Imagen generada ────────────────────────────────────────────────────── */

function ImageContent({ msg }: { msg: ChatMsg }) {
  const chat = useChat()
  const [copied, setCopied] = useState(false)
  const caption = msg.content

  return (
    <div className="group/img max-w-md">
      {msg.assetUrl ? (
        <a
          href={msg.assetUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Abrir imagen generada en tamaño completo"
          className="block overflow-hidden rounded-2xl ring-1 ring-border/60 transition-shadow hover:ring-emerald-500/40"
        >
          {/* Alt descriptivo: el prompt real, no texto genérico */}
          <img
            src={msg.assetUrl}
            alt={caption ? `Imagen generada: ${caption}` : 'Imagen generada por OE AI LLM'}
            className="w-full bg-secondary/30"
            loading="lazy"
          />
        </a>
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-2xl border border-border/60 bg-secondary/40 text-sm text-muted-foreground">
          Imagen no disponible
        </div>
      )}

      {caption && (
        <p className="mt-1.5 line-clamp-2 px-0.5 text-[11px] leading-snug text-muted-foreground" title={caption}>
          {caption}
        </p>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-1.5 opacity-70 transition-opacity group-hover/img:opacity-100">
        {typeof msg.meta?.latencyMs === 'number' && msg.meta.latencyMs > 0 && (
          <Badge variant="outline" className="gap-1 border-border/60 text-[10px] text-muted-foreground">
            <BadgeCheck className="size-3 text-emerald-400" aria-hidden />
            Imagen · {(msg.meta.latencyMs / 1000).toFixed(1)} s
          </Badge>
        )}
        {msg.assetUrl && (
          <a
            href={msg.assetUrl}
            download
            aria-label="Descargar imagen"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Download className="size-3" aria-hidden />
            Descargar
          </a>
        )}
        {caption && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(caption).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1600)
              })
            }}
            aria-label="Copiar descripción de la imagen"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
            {copied ? 'Copiado' : 'Copiar prompt'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void chat.generateImage(caption)}
          disabled={chat.pending || !caption}
          aria-label="Generar otra imagen con la misma descripción"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="size-3" aria-hidden />
          Volver a generar
        </button>
      </div>
    </div>
  )
}

/* ── Copiar genérico ────────────────────────────────────────────────────── */

function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        })
      }}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  )
}

/** Nota de enrutamiento del orquestador (mostrada bajo el composer). */
export function RouteNote() {
  const chat = useChat()
  return (
    <AnimatePresence>
      {chat.routeNote && !chat.error && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          className="mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/8 px-3.5 py-1.5 text-[11px] text-emerald-200/90"
          role="status"
        >
          <Waypoints className="size-3.5 shrink-0 text-emerald-400" aria-hidden />
          <span className="truncate" title={chat.routeNote}>
            {chat.routeNote}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
