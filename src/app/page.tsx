'use client'

import { OeAiApp } from '@/components/chat/oe-ai-app'

/**
 * OE AI — interfaz premium de chat con el modelo unificado OE AI LLM.
 * Shell completo estilo GPT: sidebar, historial privado, conexiones (red de
 * 128 modelos), Instantáneo/Reflexivo y Centro de APIs en /apis.
 *
 * Cada conversación de un usuario verificado vive en su propia dirección
 * /c/<id> (privada: solo la lee su dueño). Los invitados demo obtienen un
 * único chat temporal sin historial.
 */
export default function Home() {
  return <OeAiApp />
}
