'use client'

/**
 * Sidebar estilo GPT: nuevo chat, buscador, conexiones (red de modelos),
 * historial de conversaciones y perfil. Colapsable con animación en escritorio
 * y drawer superpuesto en móvil.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Download,
  FileDown,
  Hammer,
  Loader2,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Share2,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CATALOG } from '@/lib/ai/catalog/catalog'
import { exportConversationById } from '@/lib/export-chat'
import { exportConversationByIdAsPdf } from '@/lib/export-pdf'
import { useAuth } from '@/components/auth/auth-provider'
import { LoginButtons } from '@/components/auth/login-buttons'
import { useUiStore } from '@/lib/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useChat } from './chat-context'
import { OeLogo } from './oe-logo'

const NETWORK_COUNT = CATALOG.length

/** Copia al portapapeles con fallback honesto (execCommand) para contextos sin API asíncrona. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // contexto sin permiso o sin API: se intenta el respaldo
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export function Sidebar() {
  const chat = useChat()
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen)
  const setNetworkOpen = useUiStore((s) => s.setNetworkOpen)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const isMobile = useIsMobile()

  // Móvil: el drawer se cierra con Escape
  useEffect(() => {
    if (!isMobile || !sidebarOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMobile, sidebarOpen, setSidebarOpen])

  /* ── Móvil: drawer superpuesto ─────────────────────────────────────────── */
  if (isMobile) {
    return (
      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
            <motion.aside
              key="drawer"
              initial={{ x: -320 }}
              animate={{ x: 0 }}
              exit={{ x: -320 }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
              className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border/60 bg-sidebar"
              aria-label="Panel lateral"
            >
              <SidebarContent collapsed={false} onNavigate={() => setSidebarOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    )
  }

  /* ── Escritorio: columna integrada con ancho animado ───────────────────── */
  return (
    <motion.aside
      initial={false}
      animate={{ width: sidebarOpen ? 288 : 72 }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      className="relative z-30 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-border/60 bg-sidebar md:flex"
      aria-label="Panel lateral"
    >
      <SidebarContent collapsed={!sidebarOpen} onToggle={toggleSidebar} />
      {/* Botón flotante cuando está colapsado */}
      {!sidebarOpen && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebar}
                  aria-label="Expandir panel lateral"
                  className="size-9 text-muted-foreground hover:text-foreground"
                >
                  <PanelLeftOpen className="size-4.5" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Expandir panel</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
    </motion.aside>
  )
}

function SidebarContent({
  collapsed,
  onToggle,
  onNavigate,
}: {
  collapsed: boolean
  onToggle?: () => void
  onNavigate?: () => void
}) {
  const chat = useChat()
  const { user, loading: authLoading } = useAuth()
  const setNetworkOpen = useUiStore((s) => s.setNetworkOpen)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** Conversación cuyo enlace compartido se está generando (Loader2 en el ítem). */
  const [sharingId, setSharingId] = useState<string | null>(null)

  /** Comparte una conversación: crea/reutiliza el enlace y lo copia al portapapeles. */
  async function shareConversation(id: string, title: string) {
    if (sharingId) return
    setSharingId(id)
    try {
      // Token de Supabase: los chats privados solo se comparten desde la cuenta dueña.
      const { getSupabase, supabaseConfigured } = await import('@/lib/supabase')
      const token = supabaseConfigured ? (await getSupabase().auth.getSession()).data.session?.access_token : null
      const res = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}/share`, {
        method: 'POST',
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      })
      const data = (await res.json().catch(() => null)) as { url?: string; token?: string; reused?: boolean; error?: string } | null
      if (!res.ok || !data?.url) {
        throw new Error(data?.error ?? `No se pudo crear el enlace (error ${res.status}).`)
      }
      const absolute = data.url.startsWith('http') ? data.url : `${window.location.origin}${data.url}`
      const copied = await copyToClipboard(absolute)
      if (copied) {
        toast.success('Enlace copiado', {
          description: `Cualquiera con el enlace podrá leer esta conversación · ${absolute}`,
          duration: 8000,
        })
      } else {
        toast.error('No se pudo copiar el enlace', {
          description: `Cópialo manualmente: ${absolute}`,
          duration: 10000,
        })
      }
    } catch (err) {
      toast.error(`No se pudo compartir «${title}»`, {
        description: err instanceof Error ? err.message : 'Error desconocido al compartir.',
      })
    } finally {
      setSharingId(null)
    }
  }

  const items = [
    { key: 'new', label: 'Nuevo chat', hint: 'Ctrl+Shift+O', icon: Plus, action: () => chat.newChat() },
    { key: 'search', label: 'Buscar', hint: 'Ctrl+K', icon: Search, action: () => setSearchOpen(true) },
    {
      key: 'network',
      label: 'Conexiones',
      hint: `${CATALOG.length} modelos en la red`,
      icon: Network,
      action: () => setNetworkOpen(true),
    },
  ] as Array<{ key: string; label: string; hint: string; icon: typeof Plus; construction?: boolean; action: () => void }>

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Cabecera: logo + colapsar */}
      <div className={cn('flex items-center gap-2 px-3 pt-4 pb-2', collapsed && 'justify-center px-2')}>
        <OeLogo size="sm" />
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -6 }}
              transition={{ duration: 0.18 }}
              className="flex min-w-0 flex-1 items-center justify-between"
            >
              <span className="truncate text-[15px] font-semibold tracking-tight">OE AI</span>
              {onToggle && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggle}
                  aria-label="Contraer panel lateral"
                  className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <PanelLeftClose className="size-4.5" aria-hidden />
                </Button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Acciones principales */}
      <nav className={cn('flex flex-col gap-0.5 px-2', collapsed && 'px-2.5')} aria-label="Acciones principales">
        {items.map((item) =>
          collapsed ? (
            <TooltipProvider key={item.key} delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={item.action}
                    aria-label={item.label}
                    className="grid size-10 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <item.icon className="size-[18px]" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <span className="font-medium">{item.label}</span>
                  <span className="ml-2 text-muted-foreground">{item.hint}</span>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                item.action()
                onNavigate?.()
              }}
              className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-foreground/85 transition-colors hover:bg-accent hover:text-foreground"
            >
              <item.icon className="size-[18px] shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
              <span className="flex-1 text-left font-medium">{item.label}</span>
              {item.key === 'network' && (
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
                  {CATALOG.length}
                </span>
              )}
              {item.construction && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                  <Hammer className="size-3" aria-hidden />
                  En construcción
                </span>
              )}
              {item.hint !== `${CATALOG.length} modelos` && !item.construction && (
                <kbd className="hidden rounded border border-border/60 bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground lg:inline">
                  {item.hint}
                </kbd>
              )}
            </button>
          ),
        )}
      </nav>

      {/* Historial (solo usuarios verificados: los chats son privados por cuenta).
          Invitados demo: una sola conversación temporal, sin historial. */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        {user ? (
          <>
            {!collapsed && (
              <h2 className="px-4 pb-1 text-xs font-medium tracking-wide text-muted-foreground">Historial</h2>
            )}
            <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {chat.conversations.length === 0 ? (
                <p className={cn('px-3 py-4 text-xs leading-relaxed text-muted-foreground', collapsed && 'hidden')}>
                  Tus conversaciones aparecerán aquí.
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5" aria-label="Conversaciones recientes">
              {chat.conversations.map((c) => {
                const active = c.id === chat.activeId
                const renaming = renamingId === c.id
                return (
                  <li key={c.id} className="group relative">
                    {renaming ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          const draft = renameDraft.trim()
                          setRenamingId(null)
                          if (draft && draft !== c.title) void chat.renameConversation(c.id, draft)
                        }}
                        className="px-1 py-1"
                      >
                        <label htmlFor={`rename-${c.id}`} className="sr-only">
                          Nuevo nombre de la conversación
                        </label>
                        <input
                          id={`rename-${c.id}`}
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value.slice(0, 80))}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          autoFocus
                          maxLength={80}
                          className="w-full rounded-lg border border-emerald-500/40 bg-secondary/60 px-2.5 py-2 text-sm text-foreground focus:outline-none"
                        />
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            if (!active) void chat.loadConversation(c.id)
                            onNavigate?.()
                          }}
                          aria-current={active ? 'true' : undefined}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-xl py-2.5 pr-9 text-left text-sm transition-colors',
                            collapsed ? 'justify-center px-0' : 'px-3',
                            active
                              ? 'bg-accent text-foreground'
                              : 'text-foreground/75 hover:bg-accent/60 hover:text-foreground',
                          )}
                        >
                          <MessageSquare
                            className={cn('size-4 shrink-0', active ? 'text-emerald-300' : 'text-muted-foreground')}
                            aria-hidden
                          />
                          {!collapsed && (
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium leading-snug">{c.title}</span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true, locale: es })}
                              </span>
                            </span>
                          )}
                        </button>
                        {!collapsed && (
                          <div className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 group-hover:block">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={`Opciones de la conversación: ${c.title}`}
                                  className="rounded-lg bg-sidebar/80 p-1.5 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
                                >
                                  <SquarePen className="size-3.5" aria-hidden />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="right" align="start" className="w-48">
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRenameDraft(c.title)
                                    setRenamingId(c.id)
                                  }}
                                >
                                  <Pencil className="size-4" aria-hidden />
                                  Renombrar
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={sharingId !== null}
                                  onSelect={(e) => {
                                    e.preventDefault()
                                    void shareConversation(c.id, c.title)
                                  }}
                                >
                                  {sharingId === c.id ? (
                                    <Loader2 className="size-4 animate-spin" aria-hidden />
                                  ) : (
                                    <Share2 className="size-4" aria-hidden />
                                  )}
                                  {sharingId === c.id ? 'Generando enlace…' : 'Compartir'}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => void exportConversationById(c.id, c.title)}
                                >
                                  <Download className="size-4" aria-hidden />
                                  Exportar (.md)
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => void exportConversationByIdAsPdf(c.id, c.title)}
                                >
                                  <FileDown className="size-4" aria-hidden />
                                  Exportar PDF
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => void chat.deleteConversation(c.id)}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <Trash2 className="size-4" aria-hidden />
                                  Eliminar
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        )}
                      </>
                    )}
                  </li>
                )
              })}
                </ul>
              )}
            </div>
          </>
        ) : !authLoading && !collapsed ? (
          <div className="px-2 pb-2">
            <div className="rounded-2xl border border-border/60 bg-secondary/50 p-3">
              <p className="text-xs font-semibold text-foreground">Chats privados con historial</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Inicia sesión para guardar tus conversaciones y abrir cada chat en su
                propia dirección <span className="font-mono">/c/…</span>. Como invitado
                usas un chat temporal sin historial.
              </p>
              <div className="mt-2.5">
                <LoginButtons layout="block" />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Perfil */}
      <div className={cn('border-t border-border/50 p-3', collapsed && 'px-2.5')}>
        <div
          className={cn(
            'flex items-center gap-2.5 rounded-xl px-1.5 py-1.5',
            collapsed && 'justify-center px-0',
          )}
        >
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 text-[11px] font-bold text-emerald-950"
          >
            OB
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium leading-tight">OE BUSINESS</span>
              <span className="block text-[11px] text-muted-foreground">Studio · OE AI LLM</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
