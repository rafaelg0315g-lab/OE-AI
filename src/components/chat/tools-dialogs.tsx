'use client'

/**
 * Diálogos de herramientas del composer (Task 19-e):
 *
 * - VideoDialog: generación de video IA (POST /api/tools/video vía
 *   chat.generateVideo del hook). Prompt + tamaño + duración + audio IA.
 * - ImageEditDialog: edición de imagen IA (POST /api/tools/image-edit vía
 *   chat.generateImageEdit). Imagen de referencia + instrucción del cambio.
 * - ReadDocDialog: lectura de un enlace web o PDF (POST /api/tools/read-doc
 *   se hace AL ENVIAR el mensaje, en el composer): aquí solo se elige la
 *   fuente y se entrega un "documento pendiente" al composer.
 *
 * Errores honestos con toasts sonner; los errores de cuota de invitado (403)
 * activan la compuerta desde el hook, el diálogo solo informa.
 */
import { useRef, useState } from 'react'
import { Clapperboard, FileText, Loader2, Mic, Wand2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { fileToDownscaledDataUrl } from '@/lib/image-client'
import type { OeChatApi } from '@/hooks/use-oe-chat'

/* ── VideoDialog ──────────────────────────────────────────────────────────── */

export function VideoDialog({
  open,
  onOpenChange,
  chat,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  chat: OeChatApi
}) {
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState<string>('5')
  const [busy, setBusy] = useState(false)

  function reset() {
    setPrompt('')
    setDuration('5')
  }

  async function handleGenerate() {
    const clean = prompt.trim()
    if (!clean || busy) return
    setBusy(true)
    try {
      const result = await chat.generateVideo({
        prompt: clean,
        duration: Number(duration) === 10 ? 10 : 5,
        withAudio: true,
      })
      if (result.ok) {
        onOpenChange(false)
        reset()
        toast('Video en generación…', {
          description: 'Escenas IA + narración + subtítulos. Tarda de 1 a 3 minutos; lo verás aquí mismo.',
        })
      } else {
        toast.error(result.error ?? 'No se pudo generar el video.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="rounded-2xl border-border/70 bg-secondary/80 backdrop-blur-xl sm:max-w-md sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 place-items-center rounded-lg bg-emerald-500/15">
              <Clapperboard className="size-4 text-emerald-300" aria-hidden />
            </span>
            Generar video (IA)
          </DialogTitle>
          <DialogDescription>
            Describe la historia o escena. Se crea un video vertical narrado con imágenes IA, voz y subtítulos.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="video-prompt">Descripción</Label>
            <Textarea
              id="video-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, 800))}
              placeholder="Ej: Olas del mar al atardecer, cámara lenta, luz dorada"
              rows={3}
              className="resize-none bg-background/60"
            />
            <span className="self-end font-mono text-[10px] text-muted-foreground">{prompt.length}/800</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="video-duration">Extensión</Label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger id="video-duration" className="w-full bg-background/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">Corto · ~2 escenas</SelectItem>
                  <SelectItem value="10">Largo · ~3 escenas</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Formato</span>
              <div className="flex h-9 items-center rounded-md border border-border/60 bg-background/60 px-3 text-[13px] text-muted-foreground">
                Vertical 9:16 · tipo story
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5">
            <Mic className="size-4 shrink-0 text-emerald-300" aria-hidden />
            <p className="text-[12px] leading-snug text-emerald-100/90">
              Incluye narración con voz IA y subtítulos automáticos en tu idioma.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={() => void handleGenerate()}
            disabled={busy || prompt.trim().length === 0 || chat.pending}
            className="gap-2 bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 hover:from-emerald-300 hover:to-teal-500"
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Generando… puede tardar 1-3 minutos
              </>
            ) : (
              'Generar video'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ── ImageEditDialog ─────────────────────────────────────────────────────── */

const MAX_EDIT_BYTES = 6 * 1024 * 1024

export function ImageEditDialog({
  open,
  onOpenChange,
  chat,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  chat: OeChatApi
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  function reset() {
    setPreviewUrl(null)
    setImageDataUrl(null)
    setPrompt('')
    setNote(null)
  }

  async function handleFile(file: File | undefined | null) {
    if (!file) return
    setNote(null)
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      setNote('Formato no soportado: usa PNG, JPEG o WebP.')
      return
    }
    if (file.size > MAX_EDIT_BYTES) {
      setNote('La imagen supera los 6 MB. Elige una más ligera.')
      return
    }
    setLoadingFile(true)
    try {
      // Se reduce como la visión del chat: JPEG ≤1280 px, carga ligera y fiable.
      const dataUrl = await fileToDownscaledDataUrl(file)
      setImageDataUrl(dataUrl)
      setPreviewUrl(dataUrl)
    } catch {
      setNote('No se pudo leer la imagen. Inténtalo con otro archivo.')
    } finally {
      setLoadingFile(false)
    }
  }

  async function handleEdit() {
    const clean = prompt.trim()
    if (!clean || !imageDataUrl || busy) return
    setBusy(true)
    try {
      const result = await chat.generateImageEdit({ imageDataUrl, previewUrl: imageDataUrl, prompt: clean })
      if (result.ok) {
        onOpenChange(false)
        reset()
        toast('Imagen editada', { description: 'El resultado se añadió a la conversación.' })
      } else {
        toast.error(result.error ?? 'No se pudo editar la imagen.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="rounded-2xl border-border/70 bg-secondary/80 backdrop-blur-xl sm:max-w-md sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 place-items-center rounded-lg bg-emerald-500/15">
              <Wand2 className="size-4 text-emerald-300" aria-hidden />
            </span>
            Editar imagen (IA)
          </DialogTitle>
          <DialogDescription>
            Sube una imagen y dile qué cambio quieres: la IA genera una nueva versión.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              void handleFile(e.target.files?.[0])
              e.currentTarget.value = ''
            }}
          />

          {previewUrl ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/40 p-1.5 pr-2">
              <img
                src={previewUrl}
                alt="Imagen a editar"
                className="size-12 shrink-0 rounded-lg object-cover ring-1 ring-border/60"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Imagen lista para editar</span>
              <button
                type="button"
                onClick={() => {
                  setPreviewUrl(null)
                  setImageDataUrl(null)
                }}
                aria-label="Quitar imagen seleccionada"
                className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loadingFile}
              className="flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-background/30 text-xs text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-foreground"
            >
              {loadingFile ? (
                <>
                  <Loader2 className="size-5 animate-spin text-emerald-300" aria-hidden />
                  Preparando imagen…
                </>
              ) : (
                <>
                  <Wand2 className="size-5 text-emerald-300" aria-hidden />
                  Elegir imagen (PNG, JPEG o WebP · máx. 6 MB)
                </>
              )}
            </button>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="image-edit-prompt">¿Qué cambio quieres?</Label>
            <Textarea
              id="image-edit-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, 600))}
              placeholder="Ej: cambia el fondo a una playa"
              rows={2}
              className="resize-none bg-background/60"
            />
            <span className="self-end font-mono text-[10px] text-muted-foreground">{prompt.length}/600</span>
          </div>

          {note && (
            <p className="text-[11px] text-amber-300/90" role="status">
              {note}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={() => void handleEdit()}
            disabled={busy || loadingFile || !imageDataUrl || prompt.trim().length === 0 || chat.pending}
            className="gap-2 bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 hover:from-emerald-300 hover:to-teal-500"
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Editando… ~30-60 s
              </>
            ) : (
              'Editar imagen'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ── ReadDocDialog ───────────────────────────────────────────────────────── */

export interface PendingDoc {
  kind: 'url' | 'pdf'
  url?: string
  file?: File
  name: string
  title?: string
}

const MAX_PDF_BYTES = 15 * 1024 * 1024

export function ReadDocDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Entrega el documento pendiente al composer (NO llama al backend aquí). */
  onConfirm: (doc: PendingDoc) => void
}) {
  const [tab, setTab] = useState('url')
  const [url, setUrl] = useState('')
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  function reset() {
    setUrl('')
    setPdfFile(null)
    setNote(null)
  }

  function confirm() {
    if (tab === 'url') {
      const clean = url.trim()
      if (!/^https?:\/\/\S+$/i.test(clean)) {
        setNote('Ingresa un enlace válido que empiece por https://')
        return
      }
      onConfirm({ kind: 'url', url: clean, name: clean })
      onOpenChange(false)
      reset()
      return
    }
    const file = pdfFile
    if (!file) {
      setNote('Elige un archivo PDF primero.')
      return
    }
    if (file.size > MAX_PDF_BYTES) {
      setNote('El PDF supera los 15 MB. Elige uno más ligero.')
      return
    }
    onConfirm({ kind: 'pdf', file, name: file.name })
    onOpenChange(false)
    reset()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl border-border/70 bg-secondary/80 backdrop-blur-xl sm:max-w-md sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 place-items-center rounded-lg bg-emerald-500/15">
              <FileText className="size-4 text-emerald-300" aria-hidden />
            </span>
            Leer enlace o PDF
          </DialogTitle>
          <DialogDescription>
            OE AI leerá el contenido y podrás preguntarle sobre él con tu siguiente mensaje.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="url" className="flex-1 gap-1.5">
              Enlace
            </TabsTrigger>
            <TabsTrigger value="pdf" className="flex-1 gap-1.5">
              PDF
            </TabsTrigger>
          </TabsList>

          <TabsContent value="url" className="flex flex-col gap-2 pt-1">
            <Label htmlFor="read-doc-url">Enlace de la página</Label>
            <Input
              id="read-doc-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/articulo"
              className="bg-background/60"
            />
          </TabsContent>

          <TabsContent value="pdf" className="flex flex-col gap-2 pt-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                setPdfFile(e.target.files?.[0] ?? null)
                setNote(null)
                e.currentTarget.value = ''
              }}
            />
            <Label>Archivo PDF (máx. 15 MB)</Label>
            {pdfFile ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/40 p-1.5 pr-2">
                <FileText className="ml-1 size-5 shrink-0 text-emerald-300" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{pdfFile.name}</span>
                <button
                  type="button"
                  onClick={() => setPdfFile(null)}
                  aria-label="Quitar PDF seleccionado"
                  className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-20 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-background/30 text-xs text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-foreground"
              >
                <FileText className="size-5 text-emerald-300" aria-hidden />
                Elegir archivo PDF
              </button>
            )}
          </TabsContent>
        </Tabs>

        {note && (
          <p className="text-[11px] text-amber-300/90" role="status">
            {note}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={confirm} className="gap-2 bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 hover:from-emerald-300 hover:to-teal-500">
            Leer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
