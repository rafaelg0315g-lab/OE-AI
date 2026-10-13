import type { Metadata } from 'next'
import { OeAiApp } from '@/components/chat/oe-ai-app'

/**
 * /c/[id] — dirección propia de cada conversación (estilo /c/ de ChatGPT).
 *
 * PRIVACIDAD: el contenido lo sirve /api/chat/history, que solo devuelve
 * mensajes al propietario verificado (token Supabase). Para cualquier otra
 * persona —incluidos invitados demo— la interfaz muestra el aviso de chat
 * privado, indistinguible de un chat inexistente.
 */
export const metadata: Metadata = {
  title: 'Chat · OE AI',
  robots: { index: false, follow: false }, // los chats privados no se indexan
}

export default async function ChatByIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <OeAiApp initialChatId={id} />
}
