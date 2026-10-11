/** Tipos auxiliares compartidos (evita dependencias circulares). */
export interface AdapterChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
