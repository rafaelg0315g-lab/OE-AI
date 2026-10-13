'use client'

/**
 * Composer premium estilo GPT/Meta AI: entrada grande redondeada con botón "+"
 * (acciones rápidas), selector de modo (Instantáneo / Reflexivo), dictado por
 * voz (Web Speech API) y envío con animación. Enter envía, Shift+Enter salta línea.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, AudioLines, BookOpen, Boxes, Brain, Clapperboard, Eye, FileText, Globe, ImagePlus, Loader2, Mic, Network, Plus, Sparkles, Square, Wand2, X, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CATALOG } from '@/lib/ai/catalog/catalog'
import { fileToDownscaledDataUrl } from '@/lib/image-client'
import { useUiStore } from '@/lib/store/ui-store'
import { useAuth } from '@/components/auth/auth-provider'
import { cn } from '@/lib/utils'
import { useChat } from './chat-context'
import { GuestGateOverlay, GuestQuotaPill } from './guest-gate'
import { ImageEditDialog, ReadDocDialog, VideoDialog, type PendingDoc } from './tools-dialogs'
import { VoiceNoteButton } from './voice-note-button'

/* Tipado mínimo de la Web Speech API (sin dependencias externas). */
interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}
type RecognitionCtor = new () => RecognitionLike

const MAX_CHARS = 8000

function subscribeNoop(_onChange: () => void): () => void {
  // Suscripción nula: la disponibilidad de la Web Speech API no cambia en vivo.
  return () => {}
}

function getSpeechSupportSnapshot(): boolean {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition)
}

/** Imagen adjuntada lista para enviarse con el mensaje (visión). */
interface ComposerAttachment {
  assetId: string
  previewUrl: string
}

const DRAFT_PREFIX = 'oe-draft:'

export function Composer({ variant = 'docked' }: { variant?: 'hero' | 'docked' }) {
  const chat = useChat()
  const { user } = useAuth()
  const mode = useUiStore((s) => s.mode)
  const setMode = useUiStore((s) => s.setMode)
  const setNetworkOpen = useUiStore((s) => s.setNetworkOpen)
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [webSearch, setWebSearch] = useState(false)
  const [attachment, setAttachment] = useState<ComposerAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [attachNote, setAttachNote] = useState<string | null>(null)
  // Diálogos de herramientas y documento pendiente (Task 19-e)
  const [plusOpen, setPlusOpen] = useState(false)
  const [videoOpen, setVideoOpen] = useState(false)
  const [imageEditOpen, setImageEditOpen] = useState(false)
  const [readDocOpen, setReadDocOpen] = useState(false)
  const [pendingDoc, setPendingDoc] = useState<PendingDoc | null>(null)
  const [docReading, setDocReading] = useState(false)
  // Soporte de dictado: snapshot externo estable (evita setState en efecto y
  // desajustes de hidratación: false en servidor, real en cliente).
  const speechSupported = useSyncExternalStore(
    subscribeNoop,
    getSpeechSupportSnapshot,
    () => false,
  )
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const recognitionRef = useRef<RecognitionLike | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const skipDraftSaveRef = useRef(true)

  // Auto-altura del textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [input])

  // Borrador autoguardado: al cambiar de conversación se restaura el suyo
  // (y se limpia cualquier adjunto o documento pendiente del contexto anterior).
  useEffect(() => {
    skipDraftSaveRef.current = true
    setAttachment(null)
    setAttachNote(null)
    setPendingDoc(null)
    try {
      setInput(window.localStorage.getItem(`${DRAFT_PREFIX}${chat.activeId ?? 'new'}`) ?? '')
    } catch {
      setInput('')
    }
  }, [chat.activeId])

  // Guardar el borrador al escribir (se omite el guardado justo tras cargar).
  useEffect(() => {
    if (skipDraftSaveRef.current) {
      skipDraftSaveRef.current = false
      return
    }
    try {
      window.localStorage.setItem(`${DRAFT_PREFIX}${chat.activeId ?? 'new'}`, input)
    } catch {
      // sin almacenamiento disponible
    }
  }, [input, chat.activeId])

  // Foco desde atajo / chip de sugerencia
  useEffect(() => {
    const focus = () => textareaRef.current?.focus()
    window.addEventListener('oe-focus-composer', focus)
    return () => window.removeEventListener('oe-focus-composer', focus)
  }, [])

  /** Envía el mensaje con el documento pendiente: primero lee el enlace/PDF
   *  (POST /api/tools/read-doc) y luego envía el turno con docContext. Si la
   *  lectura falla, NO se envía nada (error honesto con toast). */
  async function submitWithDoc(text: string) {
    const doc = pendingDoc
    if (!doc || docReading) return
    setDocReading(true)
    try {
      let body: Record<string, unknown>
      if (doc.kind === 'url') {
        body = { url: doc.url, name: doc.name }
      } else {
        const file = doc.file
        if (!file) throw new Error('El archivo del documento ya no está disponible.')
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error('No se pudo leer el PDF.'))
          reader.readAsDataURL(file)
        })
        body = { fileDataUrl: dataUrl, name: doc.name }
      }
      const res = await fetch('/api/tools/read-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => null)) as { title?: string; text?: string; error?: string } | null
      if (!res.ok || !data?.text) {
        throw new Error(data?.error ?? 'No se pudo leer el documento.')
      }
      const title = (data.title ?? '').trim() || doc.name
      toast.success(`Documento leído: ${title}`)
      setPendingDoc(null)
      setInput('')
      try {
        window.localStorage.setItem(`${DRAFT_PREFIX}${chat.activeId ?? 'new'}`, '')
      } catch {
        // sin almacenamiento
      }
      void chat.send(text, { docContext: data.text, docTitle: title })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo leer el documento.')
    } finally {
      setDocReading(false)
    }
  }

  function submit() {
    const text = input.trim()
    if ((!text && !attachment && !pendingDoc) || chat.pending || uploading || docReading) return

    // Documento pendiente (enlace/PDF): se lee y el turno lleva su contexto.
    if (pendingDoc) {
      void submitWithDoc(text || '¿De qué trata este documento?')
      return
    }

    // Imagen adjuntada: turno de visión (el núcleo analiza la imagen con el texto).
    if (attachment) {
      const finalText = text || 'Describe esta imagen en detalle.'
      const att = attachment
      setInput('')
      setAttachment(null)
      setAttachNote(null)
      try {
        window.localStorage.setItem(`${DRAFT_PREFIX}${chat.activeId ?? 'new'}`, '')
      } catch {
        // sin almacenamiento
      }
      void chat.send(finalText, { attachment: { assetId: att.assetId, previewUrl: att.previewUrl } })
      return
    }

    // Comandos del núcleo: /imagen y /buscar
    if (text.startsWith('/imagen ')) {
      const prompt = text.slice('/imagen '.length).trim()
      if (prompt.length >= 3) {
        setInput('')
        void chat.generateImage(prompt)
      }
      return
    }
    if (text === '/imagen') {
      setInput('/imagen ')
      window.dispatchEvent(new Event('oe-focus-composer'))
      return
    }
    if (text.startsWith('/buscar ')) {
      const query = text.slice('/buscar '.length).trim()
      if (query) {
        setInput('')
        void chat.send(query, { webSearch: true })
      }
      return
    }
    if (text === '/buscar') {
      setInput('/buscar ')
      window.dispatchEvent(new Event('oe-focus-composer'))
      return
    }

    setInput('')
    void chat.send(text, { webSearch })
    if (webSearch) setWebSearch(false)
  }

  /** Prepara y sube una imagen adjuntada (botón, arrastre o portapapeles). */
  async function handleFiles(files: FileList | File[] | null) {
    const file = Array.from(files ?? [])[0]
    if (!file || uploading) return
    setAttachNote(null)
    if (!file.type.startsWith('image/')) {
      setAttachNote('Solo se pueden adjuntar imágenes (PNG, JPEG, WebP, GIF).')
      return
    }
    if (file.size > 12 * 1024 * 1024) {
      setAttachNote('La imagen supera los 12 MB. Elige una más ligera.')
      return
    }
    setUploading(true)
    try {
      const dataUrl = await fileToDownscaledDataUrl(file)
      const res = await fetch('/api/assets/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      })
      const data = (await res.json().catch(() => null)) as { id?: string; url?: string; error?: string } | null
      if (!res.ok || !data?.id || !data.url) {
        throw new Error(data?.error ?? 'No se pudo subir la imagen.')
      }
      setAttachment({ assetId: data.id, previewUrl: data.url })
    } catch (err) {
      setAttachNote(err instanceof Error ? err.message : 'No se pudo subir la imagen.')
    } finally {
      setUploading(false)
    }
  }

  function toggleDictation() {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = 'es-CO'
    rec.continuous = false
    rec.interimResults = false
    rec.onresult = (e) => {
      const transcript = Array.from({ length: e.results.length }, (_, i) => e.results[i][0]?.transcript ?? '')
        .join(' ')
        .trim()
      if (transcript) setInput((prev) => (prev ? `${prev} ${transcript}` : transcript))
    }
    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }
    rec.onerror = () => {
      setListening(false)
      recognitionRef.current = null
    }
    recognitionRef.current = rec
    setListening(true)
    rec.start()
  }

  // Cuota agotada (invitados): el envío queda bloqueado en UI; el servidor lo impone siempre.
  const canSend =
    (input.trim().length > 0 || Boolean(attachment) || Boolean(pendingDoc)) &&
    !chat.pending &&
    !chat.guestBlocked &&
    !uploading &&
    !docReading
  const nearLimit = input.length > MAX_CHARS - 500

  return (
    <div className={cn('w-full', variant === 'hero' ? '' : 'pb-3')}>
      {/* Cuota de invitado: contador discreto (solo usuarios sin sesión) */}
      <GuestQuotaPill className="mb-2.5" />
      <motion.div
        initial={variant === 'hero' ? { opacity: 0, y: 18, scale: 0.985 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="oe-composer-glow relative rounded-[28px] border border-border/70 bg-secondary/45 shadow-[0_10px_50px_-16px_oklch(0_0_0/0.55)] backdrop-blur-xl"
      >
        {/* Campo de texto */}
        <label htmlFor="oe-composer-input" className="sr-only">
          Pregunta a OE AI
        </label>
        <textarea
          id="oe-composer-input"
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, MAX_CHARS))}
          onPaste={(e) => {
            // Pegar una imagen del portapapeles la adjunta para visión.
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
            if (files.length > 0) {
              e.preventDefault()
              void handleFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={variant === 'hero' ? 2 : 1}
          placeholder="Pregunta a OE AI… escribe /imagen, /buscar o pega una imagen"
          aria-label="Pregunta a OE AI"
          className="scrollbar-slim block max-h-[200px] w-full resize-none bg-transparent px-5 pt-4 pb-1 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground/80 focus:outline-none"
        />

        {/* Imagen adjuntada (visión) o subida en curso */}
        {(attachment || uploading) && (
          <div className="mx-4 mb-1 flex items-center gap-2.5 rounded-xl border border-border/60 bg-secondary/50 p-1.5 pr-2">
            {uploading ? (
              <>
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary/70">
                  <Loader2 className="size-4 animate-spin text-emerald-300" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Preparando imagen…</span>
              </>
            ) : attachment ? (
              <>
                <img
                  src={attachment.previewUrl}
                  alt="Imagen adjuntada para análisis"
                  className="size-10 shrink-0 rounded-lg object-cover ring-1 ring-border/60"
                />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  Imagen lista — OE AI la verá junto a tu mensaje
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAttachment(null)
                    setAttachNote(null)
                  }}
                  aria-label="Quitar imagen adjuntada"
                  className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </>
            ) : null}
          </div>
        )}
        {attachNote && (
          <p className="mx-4 mb-1 text-[11px] text-amber-300/90" role="status">
            {attachNote}
          </p>
        )}

        {/* Documento pendiente (enlace/PDF): se lee al enviar el mensaje */}
        {pendingDoc && (
          <div className="mx-4 mb-1 flex items-center gap-2.5 rounded-xl border border-border/60 bg-secondary/50 p-1.5 pr-2">
            {docReading ? (
              <>
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary/70">
                  <Loader2 className="size-4 animate-spin text-emerald-300" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Leyendo documento…</span>
              </>
            ) : (
              <>
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary/70">
                  <FileText className="size-4 text-emerald-300" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {pendingDoc.kind === 'url' ? 'Enlace' : 'PDF'}: {pendingDoc.name}
                </span>
                <button
                  type="button"
                  onClick={() => setPendingDoc(null)}
                  aria-label="Quitar documento pendiente"
                  className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </>
            )}
          </div>
        )}

        {/* Fila de controles */}
        <div className="flex items-center gap-1.5 px-3 pb-3">
          {/* + Acciones rápidas */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              void handleFiles(e.target.files)
              e.currentTarget.value = ''
            }}
          />
          <Popover open={plusOpen} onOpenChange={setPlusOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Acciones rápidas"
                className="grid size-10 place-items-center rounded-full border border-border/60 bg-secondary/40 text-muted-foreground transition-all hover:scale-105 hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-[18px]" aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              collisionPadding={12}
              className="max-h-[min(336px,60svh)] w-64 overflow-y-auto overscroll-contain rounded-2xl p-1.5 scrollbar-none"
            >
              <button
                type="button"
                onClick={() => {
                  fileInputRef.current?.click()
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Eye className="size-4 text-emerald-300" aria-hidden />
                Adjuntar imagen (visión)
              </button>
              <button
                type="button"
                onClick={() => {
                  setInput('/imagen ')
                  window.dispatchEvent(new Event('oe-focus-composer'))
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <ImagePlus className="size-4 text-emerald-300" aria-hidden />
                Generar una imagen
                <kbd className="ml-auto rounded border border-border/60 bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">/imagen</kbd>
              </button>
              <button
                type="button"
                onClick={() => {
                  setWebSearch(true)
                  window.dispatchEvent(new Event('oe-focus-composer'))
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Globe className="size-4 text-emerald-300" aria-hidden />
                Buscar en la web
                <kbd className="ml-auto rounded border border-border/60 bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">/buscar</kbd>
              </button>
              <div aria-hidden className="mx-2 my-1 border-t border-border/50" />
              {/* OE AI Web Factory: EN CONSTRUCCIÓN (el dialogo lo comunica) */}
              <button
                type="button"
                onClick={() => {
                  setPlusOpen(false)
                  useUiStore.getState().setWebFactoryOpen(true)
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Boxes className="size-4 text-emerald-300" aria-hidden />
                Web Factory (sitios web)
                <span className="ml-auto shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">Pronto</span>
              </button>
              {/* Herramientas IA (Task 19-e) */}
              <button
                type="button"
                onClick={() => {
                  setPlusOpen(false)
                  setVideoOpen(true)
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Clapperboard className="size-4 text-emerald-300" aria-hidden />
                Generar video (IA)
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlusOpen(false)
                  setImageEditOpen(true)
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Wand2 className="size-4 text-emerald-300" aria-hidden />
                Editar imagen (IA)
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlusOpen(false)
                  setReadDocOpen(true)
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <FileText className="size-4 text-emerald-300" aria-hidden />
                Leer enlace o PDF
              </button>
              <div className="flex w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-sm">
                <Mic className="size-4 shrink-0 text-emerald-300" aria-hidden />
                <span className="min-w-0 flex-1">Mensaje de voz</span>
                <span className="shrink-0">
                  <VoiceNoteButton
                    onTranscribed={(t) => {
                      setInput((prev) => (prev ? `${prev} ${t}` : t))
                      setPlusOpen(false)
                      window.dispatchEvent(new Event('oe-focus-composer'))
                    }}
                    disabled={uploading || docReading}
                  />
                </span>
              </div>
              <div aria-hidden className="mx-2 my-1 border-t border-border/50" />
              <button
                type="button"
                onClick={() => {
                  chat.newChat()
                  window.dispatchEvent(new Event('oe-focus-composer'))
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Sparkles className="size-4 text-emerald-300" aria-hidden />
                Nueva conversación
              </button>
              <button
                type="button"
                onClick={() => setNetworkOpen(true)}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Network className="size-4 text-emerald-300" aria-hidden />
                Conexiones · red de modelos
              </button>
              <a
                href="/apis"
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <BookOpen className="size-4 text-emerald-300" aria-hidden />
                Centro de APIs
              </a>
              <button
                type="button"
                onClick={() => {
                  setInput('Construye una app fullstack de ')
                  setPlusOpen(false)
                  window.dispatchEvent(new Event('oe-focus-composer'))
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                <Boxes className="size-4 text-emerald-300" aria-hidden />
                Construir una app en el chat
                <span className="ml-auto shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                  VS Code
                </span>
              </button>
            </PopoverContent>
          </Popover>

          <div className="flex-1" />

          {/* Contador cerca del límite */}
          {nearLimit && (
            <span className="mr-1 hidden font-mono text-[11px] text-muted-foreground sm:inline">
              {input.length}/{MAX_CHARS}
            </span>
          )}

          {/* Modo: Instantáneo / Reflexivo */}
          <button
            type="button"
            onClick={() => setMode(mode === 'instant' ? 'reflective' : 'instant')}
            aria-pressed={mode === 'reflective'}
            aria-label={`Modo de respuesta: ${mode === 'instant' ? 'Instantáneo' : 'Reflexivo'}. Alternar.`}
            className={cn(
              'flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-all hover:scale-[1.03]',
              mode === 'reflective'
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                : 'border-border/60 bg-secondary/40 text-foreground/85 hover:bg-accent',
            )}
          >
            {mode === 'instant' ? <Zap className="size-4" aria-hidden /> : <Brain className="size-4" aria-hidden />}
            {mode === 'instant' ? 'Instantáneo' : 'Reflexivo'}
          </button>

          {/* Dictado por voz */}
          <TooltipishButton
            label={speechSupported ? (listening ? 'Detener dictado' : 'Dictar por voz') : 'Dictado no disponible en este navegador'}
            disabled={!speechSupported}
            onClick={toggleDictation}
            active={listening}
          >
            <MicIcon className={cn('size-[18px]', listening && 'text-emerald-300')} listening={listening} />
          </TooltipishButton>

          {/* Búsqueda web activada para el próximo mensaje */}
          <TooltipishButton
            label={webSearch ? 'Búsqueda web activada: se desactivará tras enviar' : 'Buscar en la web antes de responder'}
            onClick={() => setWebSearch((v) => !v)}
            active={webSearch}
          >
            <Globe className={cn('size-[18px]', webSearch && 'text-emerald-300')} aria-hidden />
          </TooltipishButton>

          {/* Modo Voz: conversación hablada en tiempo real (Voz ➡️ Texto ➡️ IA ➡️ Voz) */}
          <TooltipishButton
            label={
              chat.guestBlocked && !user
                ? 'Se agotó tu cuota: inicia sesión para usar el modo voz'
                : 'Modo Voz: habla con OE AI LLM en tiempo real'
            }
            disabled={chat.guestBlocked && !user}
            onClick={() => window.dispatchEvent(new Event('oe-open-voice'))}
          >
            <AudioLines className="size-[18px]" aria-hidden />
          </TooltipishButton>

          {/* Enviar / Detener */}
          <AnimatePresence mode="wait" initial={false}>
            {chat.pending ? (
              <motion.button
                key="stop"
                type="button"
                onClick={chat.stop}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                aria-label="Detener respuesta"
                className="grid size-10 place-items-center rounded-full bg-foreground text-background transition-transform hover:scale-105"
              >
                <Square className="size-4 fill-current" aria-hidden />
              </motion.button>
            ) : (
              <motion.button
                key="send"
                type="button"
                onClick={submit}
                disabled={!canSend}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                whileHover={canSend ? { scale: 1.06 } : undefined}
                aria-label="Enviar mensaje"
                className={cn(
                  'grid size-10 place-items-center rounded-full transition-all',
                  canSend
                    ? 'bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 shadow-[0_4px_18px_-4px_oklch(0.78_0.14_168/0.5)]'
                    : 'cursor-not-allowed bg-secondary/50 text-muted-foreground',
                )}
              >
                <ArrowUp className="size-[18px]" strokeWidth={2.5} aria-hidden />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Compuerta: cuota agotada → iniciar sesión con Google o GitHub */}
        <GuestGateOverlay />
      </motion.div>

      {/* Diálogos de herramientas IA (Task 19-e) */}
      <VideoDialog open={videoOpen} onOpenChange={setVideoOpen} chat={chat} />
      <ImageEditDialog open={imageEditOpen} onOpenChange={setImageEditOpen} chat={chat} />
      <ReadDocDialog
        open={readDocOpen}
        onOpenChange={setReadDocOpen}
        onConfirm={(doc) => {
          setPendingDoc(doc)
          window.dispatchEvent(new Event('oe-focus-composer'))
        }}
      />

      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        Red de {CATALOG.length} modelos trabajando como uno ·{' '}
        <button type="button" className="rounded font-medium underline decoration-dotted underline-offset-2 hover:text-emerald-300" onClick={() => { setInput('/imagen '); window.dispatchEvent(new Event('oe-focus-composer')) }}>/imagen</button>
        {' '}para crear imágenes ·{' '}
        <button type="button" className="rounded font-medium underline decoration-dotted underline-offset-2 hover:text-emerald-300" onClick={() => fileInputRef.current?.click()}>adjunta una imagen</button>
        {' '}para que la IA la vea · Enter para enviar
      </p>
    </div>
  )
}

/* Botón con tooltip ligero (title + aria) para el micrófono. */
function TooltipishButton({
  label,
  disabled,
  active,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-10 place-items-center rounded-full border transition-all',
        active
          ? 'border-emerald-500/40 bg-emerald-500/15'
          : 'border-border/60 bg-secondary/40 hover:bg-accent',
        disabled ? 'cursor-not-allowed opacity-40' : 'hover:scale-105',
      )}
    >
      {children}
    </button>
  )
}

/* Micro con ondas animadas durante el dictado. */
function MicIcon({ className, listening }: { className?: string; listening?: boolean }) {
  if (!listening) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
    )
  }
  return (
    <span className={cn('flex items-end gap-[2px]', className)} aria-hidden>
      <span className="w-[3px] animate-pulse rounded-full bg-emerald-300" style={{ height: 8 }} />
      <span className="w-[3px] animate-pulse rounded-full bg-emerald-300 [animation-delay:150ms]" style={{ height: 14 }} />
      <span className="w-[3px] animate-pulse rounded-full bg-emerald-300 [animation-delay:300ms]" style={{ height: 9 }} />
    </span>
  )
}
