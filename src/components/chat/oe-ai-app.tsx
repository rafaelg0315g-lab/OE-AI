'use client'

/**
 * OeAiApp — shell premium de OE AI (estilo GPT/Meta AI).
 *
 * Composición:
 * - Sidebar colapsable con historial multi-conversación.
 * - TopBar con el modelo unificado OE AI LLM (Listo) y acceso a Ajustes.
 * - Pantalla de bienvenida animada o lista de mensajes + composer.
 * - Diálogos: Conexiones (red de 128 modelos), Buscador (Ctrl+K) y Ajustes.
 * - Vista pública de conversaciones compartidas (?share=<token>).
 * - Atajos globales: Ctrl+K (buscar), Ctrl+Shift+O (nuevo chat).
 */
import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import { ChatContext } from './chat-context'
import { Composer } from './composer'
import { GuestGateDialog } from './guest-gate'
import { MessageList, RouteNote } from './message-list'
import { NetworkDialog } from './network-dialog'
import { WebFactoryDialog } from './web-factory-dialog'
import { SearchDialog } from './search-dialog'
import { ShareView } from './share-view'
import { Sidebar } from './sidebar'
import { TopBar } from './top-bar'
import { VoiceOverlay } from './voice-overlay'
import { WelcomeScreen } from './welcome-screen'
import { LoginButtons } from '@/components/auth/login-buttons'
import { SettingsDialog } from '@/components/settings/settings-dialog'
import { useOeChat } from '@/hooks/use-oe-chat'
import { useUiStore } from '@/lib/store/ui-store'
import { useAuth } from '@/components/auth/auth-provider'

/** Aviso para /c/<id> inaccesible: chat privado de otra cuenta o inexistente. */
function PrivateChatNotice() {
  const { user, loading } = useAuth()
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md rounded-3xl border border-border/70 bg-secondary/60 p-6 text-center shadow-[0_16px_60px_-20px_oklch(0_0_0/0.55)] backdrop-blur sm:p-8">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
          <Lock className="size-6 text-amber-300" aria-hidden />
        </div>
        <h1 className="mt-4 text-lg font-semibold tracking-tight">Este chat es privado o no existe</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Las conversaciones de OE AI son privadas: solo su propietario puede
          abrirlas desde su cuenta. Si es tuyo, inicia sesión con la cuenta con
          la que lo creaste.
        </p>
        {!user && !loading && (
          <div className="mt-5 flex justify-center">
            <LoginButtons layout="block" />
          </div>
        )}
      </div>
    </main>
  )
}

export function OeAiApp({ initialChatId }: { initialChatId?: string } = {}) {
  const chat = useOeChat(initialChatId ? { initialChatId } : undefined)
  const hasMessages = chat.messages.length > 0
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Sidebar cerrado por defecto en móvil
  useEffect(() => {
    if (window.innerWidth < 768) useUiStore.getState().setSidebarOpen(false)
  }, [])

  // Atajos globales: Ctrl+Shift+O (nuevo chat)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        chat.newChat()
        window.dispatchEvent(new Event('oe-focus-composer'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chat])

  // Chips de sugerencia de la pantalla de bienvenida (con comandos del núcleo)
  useEffect(() => {
    const onSuggestion = (e: Event) => {
      const prompt = (e as CustomEvent<string>).detail
      if (typeof prompt !== 'string' || !prompt.trim()) return
      if (prompt.startsWith('/imagen ')) {
        const rest = prompt.slice('/imagen '.length).trim()
        if (rest) void chat.generateImage(rest)
        return
      }
      if (prompt.startsWith('/buscar ')) {
        const rest = prompt.slice('/buscar '.length).trim()
        if (rest) void chat.send(rest, { webSearch: true })
        return
      }
      void chat.send(prompt)
    }
    window.addEventListener('oe-send-suggestion', onSuggestion)
    return () => window.removeEventListener('oe-send-suggestion', onSuggestion)
  }, [chat])

  // Escritorio: foco del composer con "/" (cuando no se está escribiendo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        window.dispatchEvent(new Event('oe-focus-composer'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Diálogo de Ajustes: se abre desde el TopBar o el menú del usuario
  // (evento 'oe-open-settings', mismo patrón que 'oe-open-voice').
  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener('oe-open-settings', open)
    return () => window.removeEventListener('oe-open-settings', open)
  }, [])

  return (
    <ChatContext.Provider value={chat}>
      <div className="oe-grid-lines flex h-dvh overflow-hidden bg-background text-foreground">
        <Sidebar />

        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Fondo con resplandor de marca */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(60%_100%_at_50%_0%,oklch(0.78_0.14_168/0.07),transparent_70%)]"
          />

          <TopBar />

          {chat.accessDenied ? (
            <PrivateChatNotice />
          ) : hasMessages ? (
            <>
              <MessageList />
              <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
                <RouteNote />
                <Composer />
              </div>
            </>
          ) : (
            <main className="scrollbar-slim relative flex min-h-0 flex-1 flex-col overflow-y-auto">
              <WelcomeScreen />
            </main>
          )}
        </div>

        <NetworkDialog />
        <WebFactoryDialog />
        <SearchDialog />
        <GuestGateDialog />
        <VoiceOverlay />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        {/* Vista pública de conversaciones compartidas: null rápido sin ?share */}
        <ShareView />
      </div>
    </ChatContext.Provider>
  )
}
