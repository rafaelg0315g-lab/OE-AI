/**
 * Insignia de estado del catálogo de OE AI.
 * Regla de honestidad: el color nunca va solo; la etiqueta textual (statusLabel
 * que envía la API) se renderiza SIEMPRE junto a un punto de color.
 */
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ApiModelStatus } from './types'

/** Clases de color por estado: fondo tintado suave + borde + texto legible en oscuro y claro. */
const STATUS_CLASSES: Record<ApiModelStatus, string> = {
  network_member: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  connected: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  available_with_config: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  not_verified: 'border-border/80 bg-muted text-muted-foreground',
  temporarily_unavailable:
    'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  planned: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  needs_review: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
}

/** Punto de color por estado (siempre acompañado de la etiqueta textual). */
export const STATUS_DOT_CLASS: Record<ApiModelStatus, string> = {
  network_member: 'bg-emerald-500',
  connected: 'bg-emerald-500',
  available_with_config: 'bg-amber-500',
  not_verified: 'bg-zinc-400',
  temporarily_unavailable: 'bg-orange-500',
  planned: 'bg-violet-500',
  needs_review: 'bg-red-500',
}

interface StatusBadgeProps {
  status: ApiModelStatus
  /** Etiqueta textual del estado (la que envía la API en statusLabel). */
  label: string
  className?: string
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <Badge className={cn('gap-1.5 font-medium', STATUS_CLASSES[status], className)}>
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[status])}
      />
      {label}
    </Badge>
  )
}
