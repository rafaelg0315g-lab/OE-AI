'use client'

/**
 * Buscador de conversaciones y acciones (Ctrl+K) — estilo GPT.
 */
import { useEffect, useMemo } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import { MessageSquare, Network, Sparkles } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { useUiStore } from '@/lib/store/ui-store'
import { useChat } from './chat-context'

export function SearchDialog() {
  const open = useUiStore((s) => s.searchOpen)
  const setOpen = useUiStore((s) => s.setSearchOpen)
  const setNetworkOpen = useUiStore((s) => s.setNetworkOpen)
  const chat = useChat()

  // Atajo global Ctrl+K / Cmd+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!useUiStore.getState().searchOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  const sorted = useMemo(
    () =>
      [...chat.conversations].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [chat.conversations],
  )

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Buscar en OE AI"
      description="Busca conversaciones y acciones rápidas"
      className="rounded-2xl"
    >
      <CommandInput placeholder="Buscar conversaciones y acciones…" />
      <CommandList className="scrollbar-slim">
        <CommandEmpty>Sin resultados.</CommandEmpty>

        <CommandGroup heading="Acciones">
          <CommandItem
            onSelect={() => {
              setOpen(false)
              chat.newChat()
              window.dispatchEvent(new Event('oe-focus-composer'))
            }}
          >
            <Sparkles className="size-4 text-emerald-300" aria-hidden />
            Nueva conversación
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false)
              setNetworkOpen(true)
            }}
          >
            <Network className="size-4 text-emerald-300" aria-hidden />
            Ver la red de modelos (Conexiones)
          </CommandItem>
        </CommandGroup>

        {sorted.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Conversaciones">
              {sorted.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`${c.title} ${c.id}`}
                  onSelect={() => {
                    setOpen(false)
                    if (c.id !== chat.activeId) void chat.loadConversation(c.id)
                  }}
                >
                  <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true, locale: es })}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
