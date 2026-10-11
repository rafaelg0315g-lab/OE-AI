'use client'

/**
 * TopBar premium: menú (móvil), selector del modelo unificado OE AI LLM con
 * estado "Listo", y accesos a Conexiones y al Centro de APIs.
 */
import Link from 'next/link'
import { motion } from 'framer-motion'
import { BookOpen, Check, ChevronDown, Download, Menu, Network, PanelLeft, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthZone } from '@/components/auth/auth-zone'
import { CATALOG } from '@/lib/ai/catalog/catalog'
import { useUiStore } from '@/lib/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { useChat } from './chat-context'
import { OeLogo, ReadyBadge } from './oe-logo'

export function TopBar() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const setNetworkOpen = useUiStore((s) => s.setNetworkOpen)
  const isMobile = useIsMobile()
  const chat = useChat()

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border/40 bg-background/70 px-3 backdrop-blur-xl sm:px-4">
      {/* Menú / colapso */}
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleSidebar}
        aria-label={isMobile ? 'Abrir panel lateral' : 'Contraer panel lateral'}
        className="size-9 text-muted-foreground hover:text-foreground"
      >
        {isMobile ? <Menu className="size-[18px]" aria-hidden /> : <PanelLeft className="size-[18px]" aria-hidden />}
      </Button>

      {/* Selector del modelo unificado */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="group flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm transition-colors hover:bg-accent/70"
            aria-label="Modelo activo: OE AI LLM. Abrir selector"
          >
            <OeLogo size="xs" animated={false} />
            <span className="truncate font-semibold tracking-tight">OE AI LLM</span>
            <span className="hidden sm:inline-flex">
              <ReadyBadge />
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel className="flex items-center justify-between gap-2">
            <span>Modelo activo</span>
            <ReadyBadge />
          </DropdownMenuLabel>
          <DropdownMenuItem className="pointer-events-none flex-col items-start gap-1 py-2.5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Check className="size-4 text-emerald-400" aria-hidden />
              OE AI LLM
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Red unificada de {CATALOG.length} modelos. Cada solicitud la procesa el modelo unificado;
              el enrutador interno asigna la ruta óptima.
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setNetworkOpen(true)}>
            <Network className="size-4" aria-hidden />
            Ver la red de modelos ({CATALOG.length})
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/apis">
              <BookOpen className="size-4" aria-hidden />
              Centro de APIs
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {chat.focusModel && (
        <motion.span
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="hidden max-w-56 truncate rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-200 md:inline"
          title={chat.focusModel}
        >
          Enfoque: {chat.focusModel}
        </motion.span>
      )}

      <div className="flex-1" />

      {/* Ajustes (voz, traductor, instrucciones, memoria) */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => window.dispatchEvent(new Event('oe-open-settings'))}
        className="gap-1.5 text-muted-foreground hover:text-foreground"
        aria-label="Abrir ajustes"
      >
        <Settings2 className="size-4" aria-hidden />
        <span className="hidden sm:inline">Ajustes</span>
      </Button>

      {/* Exportar la conversación activa como Markdown */}
      {chat.messages.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={chat.exportActiveConversation}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
          aria-label="Exportar la conversación activa como Markdown"
          title="Exportar conversación (.md)"
        >
          <Download className="size-4" aria-hidden />
          <span className="hidden sm:inline">Exportar</span>
        </Button>
      )}

      {/* Acciones a la derecha */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setNetworkOpen(true)}
        className="gap-1.5 text-muted-foreground hover:text-foreground"
        aria-label="Ver conexiones: red de modelos"
      >
        <Network className="size-4" aria-hidden />
        <span className="hidden sm:inline">Conexiones</span>
        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
          {CATALOG.length}
        </span>
      </Button>
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <Link href="/apis" aria-label="Abrir Centro de APIs">
          <BookOpen className="size-4" aria-hidden />
          <span className="hidden sm:inline">APIs</span>
        </Link>
      </Button>

      {/* Autenticación (Supabase · Google): login o menú del usuario */}
      <AuthZone />
    </header>
  )
}
