'use client'

import { createContext, useContext } from 'react'
import type { OeChatApi } from '@/hooks/use-oe-chat'

/**
 * Contexto del chat de OE AI: un único proveedor de lógica compartido por el
 * sidebar, el composer, la lista de mensajes y los diálogos.
 */
export const ChatContext = createContext<OeChatApi | null>(null)

export function useChat(): OeChatApi {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat debe usarse dentro de <ChatContext.Provider>')
  return ctx
}
