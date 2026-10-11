'use client'

import Link from 'next/link'
import { MessageSquare } from 'lucide-react'
import { OeLogo } from '@/components/chat/oe-logo'

/**
 * Cabecera de la página pública /apis: logo OE AI y enlace de vuelta al chat.
 */
export function SiteHeader({ embedded = true }: { embedded?: boolean }) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="OE AI, inicio"
        >
          <OeLogo size="sm" animated={false} />
          <span className="flex flex-col leading-none">
            <span className="text-sm font-semibold tracking-tight">OE AI</span>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              OE Business
            </span>
          </span>
        </Link>

        <nav aria-label="Volver" className="ml-auto">
          <Link
            href="/"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <MessageSquare className="size-3.5" aria-hidden />
            {embedded ? 'Abrir el chat' : 'Volver a OE AI'}
          </Link>
        </nav>
      </div>
    </header>
  )
}
