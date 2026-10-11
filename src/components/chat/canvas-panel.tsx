'use client'

/**
 * CanvasPanel — vista previa en vivo de bloques HTML generados por el
 * asistente (estilo Claude Artifacts).
 *
 * - Sheet lateral derecho (ancho completo en móvil, máx. 3xl en escritorio).
 * - El código se ejecuta en un <iframe sandbox="allow-scripts"> con srcDoc:
 *   origen opaco, sin acceso al DOM de la app, cookies ni almacenamiento.
 * - Nota de privacidad visible y botón de copiar el código fuente.
 */
import { useState } from 'react'
import { Check, Copy, MonitorPlay } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

export function CanvasPanel({
  open,
  onOpenChange,
  code,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  code: string
}) {
  const [copied, setCopied] = useState(false)

  /** Al cerrar se resetea el estado de copia (evento, no efecto). */
  function handleOpenChange(next: boolean) {
    if (!next) setCopied(false)
    onOpenChange(next)
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
        aria-describedby="canvas-privacy-note"
      >
        <SheetHeader className="flex-row items-center gap-3 space-y-0 border-b border-border/60 pr-12">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-300"
          >
            <MonitorPlay className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-base leading-tight">Canvas</SheetTitle>
            <SheetDescription className="truncate text-xs leading-snug">
              Vista previa en vivo del bloque HTML generado
            </SheetDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1600)
              })
            }}
            aria-label="Copiar código del Canvas"
          >
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? 'Copiado' : 'Copiar código'}
          </Button>
        </SheetHeader>

        <div className="min-h-0 flex-1 bg-white">
          <iframe
            sandbox="allow-scripts"
            srcDoc={code}
            className="h-full w-full bg-white"
            title="Vista previa de Canvas"
          />
        </div>

        <p id="canvas-privacy-note" className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          El HTML se ejecuta en un marco aislado dentro de tu navegador.
        </p>
      </SheetContent>
    </Sheet>
  )
}
