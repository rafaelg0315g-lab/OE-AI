'use client'

/**
 * Tarjeta de modelo para la vista móvil del Centro de APIs (/apis).
 * Reglas de honestidad: el nombre visible nunca sustituye al ID exacto (se
 * muestran ambos), el estado viene de la API y «Chatear» solo si chatEnabled.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Clock, Copy, MessageSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/lib/store/ui-store'
import { StatusBadge } from './status-badge'
import { CATEGORY_LABELS_ES, formatDateTimeEs, visibleModelName, type ApiModel } from './types'

/** Botón de copiado al portapapeles con confirmación visual temporal. */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string
  label: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Sin permiso de portapapeles: no se anuncia éxito que no ocurrió.
      setCopied(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={handleCopy}
      className={cn('size-11 shrink-0 text-muted-foreground hover:text-foreground md:size-9', className)}
    >
      {copied ? (
        <Check className="size-4 text-emerald-500" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
    </Button>
  )
}

/** Chips de categorías orientativas (máx. 3 visibles + «+N» si hay más). */
export function CategoryChips({
  categories,
  max = 3,
  className,
}: {
  categories: string[]
  max?: number
  className?: string
}) {
  if (categories.length === 0) return null
  const visible = categories.slice(0, max)
  const extra = categories.length - visible.length
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Categorías orientativas">
      {visible.map((category) => (
        <li key={category}>
          <span
            title="Categoría orientativa, no verificada"
            className="inline-flex items-center rounded-full border border-border/60 bg-secondary/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
          >
            {CATEGORY_LABELS_ES[category] ?? category}
          </span>
        </li>
      ))}
      {extra > 0 && (
        <li>
          <span
            title="Categoría orientativa, no verificada"
            className="inline-flex items-center rounded-full border border-border/60 bg-secondary/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground/80"
          >
            +{extra}
          </span>
        </li>
      )}
    </ul>
  )
}

interface ModelCardProps {
  model: ApiModel
  onOpenDetails: (modelId: string) => void
}

export function ModelCard({ model, onOpenDetails }: ModelCardProps) {
  const name = visibleModelName(model.id)
  const lastCheck = model.lastCheckedAt ? formatDateTimeEs(model.lastCheckedAt) : null

  return (
    <Card className="gap-4 rounded-xl border-border/60 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {model.familyLabel}
          </p>
          <h3 className="mt-1 truncate text-base font-semibold tracking-tight" title={name}>
            {name}
          </h3>
          <div className="mt-1 flex min-w-0 items-center gap-1">
            <code className="min-w-0 break-all font-mono text-xs text-muted-foreground">
              {model.id}
            </code>
            <CopyButton value={model.id} label="Copiar identificador" className="size-11 md:size-8 lg:size-7" />
          </div>
        </div>
        <StatusBadge
          status={model.status}
          label={model.statusLabel}
          className="mt-0.5 shrink-0 whitespace-normal"
        />
      </div>

      <CategoryChips categories={model.categories} />

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {lastCheck ? `Última comprobación: ${lastCheck}` : 'Sin comprobación registrada todavía'}
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenDetails(model.id)}
          className="h-11 flex-1 sm:h-9 sm:flex-none"
        >
          Detalles
        </Button>
        {model.chatEnabled && (
          <Button
            type="button"
            onClick={() => useUiStore.getState().openChatWithModel(model.id)}
            className="h-11 flex-1 sm:h-9 sm:flex-none"
          >
            <MessageSquare className="size-4" aria-hidden />
            Chatear
          </Button>
        )}
      </div>
    </Card>
  )
}
