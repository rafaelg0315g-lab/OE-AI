'use client'

/**
 * OE AI Web Factory — EN CONSTRUCCIÓN.
 *
 * El generador automático de webs con vista previa y descarga .zip se está
 * reconstruyendo: este diálogo lo comunica y ofrece la vía activa mientras
 * tanto — pedir la web en el chat, donde el asistente escribe todo el código
 * como texto (archivo por archivo) con los pasos para abrirlo en VS Code o Cursor.
 */
import { HardHat, MessagesSquare } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useUiStore } from '@/lib/store/ui-store'

export function WebFactoryDialog() {
  const open = useUiStore((s) => s.webFactoryOpen)
  const setOpen = useUiStore((s) => s.setWebFactoryOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[94vw] rounded-2xl border-border/70 bg-background p-6 sm:max-w-md">
        <DialogHeader className="items-center space-y-3 text-center sm:text-center">
          <span
            className="mx-auto grid size-14 place-items-center rounded-2xl border border-amber-500/30 bg-amber-500/10"
            aria-hidden
          >
            <HardHat className="size-7 text-amber-300" />
          </span>
          <DialogTitle className="text-base">Web Factory · En construcción</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            El generador automático de sitios con vista previa y descarga .zip se está reconstruyendo.
            Estará de vuelta muy pronto.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4" role="note">
          <p className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-emerald-200">
            <MessagesSquare className="size-4" aria-hidden />
            La vía rápida: pídelo en el chat
          </p>
          <p className="text-[12.5px] leading-relaxed text-foreground/85">
            Escribe por ejemplo <span className="font-medium text-emerald-200">«Crea una web para mi restaurante»</span> y
            OE AI te entrega todo el código aquí mismo, archivo por archivo, con los pasos para montarlo en{' '}
            <span className="font-semibold text-foreground">VS Code</span> o{' '}
            <span className="font-semibold text-foreground">Cursor</span>.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
