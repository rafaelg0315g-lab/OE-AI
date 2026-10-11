'use client'

import { create } from 'zustand'

export type ChatMode = 'instant' | 'reflective'

/** Resumen de conversación para el historial del sidebar. */
export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

interface UiState {
  // ── Shell premium ────────────────────────────────────────────────────────
  /** Sidebar expandido (en escritorio); en móvil controla el drawer. */
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void

  /** Modo de respuesta del modelo unificado. */
  mode: ChatMode
  setMode: (mode: ChatMode) => void

  /** Diálogo de conexiones (red de modelos que conforman OE AI LLM). */
  networkOpen: boolean
  setNetworkOpen: (open: boolean) => void

  /** Buscador de conversaciones (Ctrl+K). */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void

  /** OE AI Web Factory: biblioteca de plantillas y componentes. */
  webFactoryOpen: boolean
  setWebFactoryOpen: (open: boolean) => void

  /** Conversaciones para el historial / buscador. */
  conversations: ConversationSummary[]
  conversationsLoaded: boolean
  setConversations: (list: ConversationSummary[], loaded?: boolean) => void

  /** Identificador del enfoque de red heredado del Centro de APIs. */
  chatModel: string
  chatModelSetAt: number
  openChatWithModel: (model: string) => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  mode: 'instant',
  setMode: (mode) => set({ mode }),

  networkOpen: false,
  setNetworkOpen: (open) => set({ networkOpen: open }),

  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),

  webFactoryOpen: false,
  setWebFactoryOpen: (open) => set({ webFactoryOpen: open }),

  conversations: [],
  conversationsLoaded: false,
  setConversations: (list, loaded = true) => set({ conversations: list, conversationsLoaded: loaded }),

  chatModel: 'auto',
  chatModelSetAt: 0,
  openChatWithModel: (model) => {
    set({ chatModel: model, chatModelSetAt: Date.now() })
    // Desde la página /apis: navegar a la app conservando el enfoque de red.
    if (typeof window !== 'undefined' && window.location.pathname !== '/') {
      try {
        window.sessionStorage.setItem('oe-ai-pending-model', model)
      } catch {
        // almacenamiento no disponible: se pierde el enfoque, sin romper la navegación
      }
      window.location.assign('/')
    }
  },
}))
