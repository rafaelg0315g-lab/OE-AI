'use client'

import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * Logo oficial de OE (placa oscura con «O» titanio y barras «E»), renderizado
 * en SVG en línea con identificadores de gradiente únicos por instancia.
 * Tamaños: xs (topbar), sm (sidebar/mensajes), md, lg, xl (bienvenida).
 */
export function OeLogo({
  size = 'md',
  className,
  animated = true,
}: {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  animated?: boolean
}) {
  // useId produce identificadores únicos; se sanearon los «:» para SVG/CSS.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const plateId = `oe-plate-${uid}`
  const titaniumId = `oe-titanium-${uid}`

  const dims = {
    xs: 'size-5',
    sm: 'size-7',
    md: 'size-9',
    lg: 'size-14',
    xl: 'size-20',
  }[size]

  return (
    <span className={cn('relative inline-grid place-items-center', dims, className)}>
      {animated && (
        <span
          aria-hidden
          className="oe-logo-halo absolute inset-0 rounded-[22%] blur-[6px] opacity-80"
        />
      )}
      <svg
        viewBox="0 0 64 64"
        fill="none"
        className="relative z-10 size-full"
        role="img"
        aria-label="OE"
      >
        <defs>
          <linearGradient id={plateId} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#12151A" />
            <stop offset="1" stopColor="#070809" />
          </linearGradient>
          <linearGradient id={titaniumId} x1="12" y1="12" x2="52" y2="52" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#E9EDF2" />
            <stop offset="0.45" stopColor="#B9C0C9" />
            <stop offset="1" stopColor="#858B95" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="14" fill={`url(#${plateId})`} />
        <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" stroke="#262B31" />
        <circle cx="23" cy="32" r="12.5" stroke={`url(#${titaniumId})`} strokeWidth="4" />
        <path
          d="M43.5 22.5h12M43.5 32h8.5M43.5 41.5h12"
          stroke={`url(#${titaniumId})`}
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">OE AI</span>
    </span>
  )
}

/** Indicador de estado "Listo" con punto pulsante y etiqueta textual. */
export function ReadyBadge({ label = 'Listo', className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300',
        className,
      )}
    >
      <span className="oe-ready-dot size-1.5 rounded-full bg-emerald-400" aria-hidden />
      {label}
    </span>
  )
}
