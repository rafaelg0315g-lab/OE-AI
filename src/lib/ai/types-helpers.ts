/** Tipos auxiliares compartidos (evita dependencias circulares). */
export interface AdapterChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Tope de seguridad para el contenido del asistente persistido/normalizado.
 * ~160k caracteres ≈ 40k tokens: sobra para respuestas de código muy largas
 * (el "modo código como texto" emite archivos completos de decenas de KB) y
 * sigue protegiendo la DB ante generaciones desbocadas.
 */
export const MAX_ASSISTANT_CONTENT_CHARS = 160_000
