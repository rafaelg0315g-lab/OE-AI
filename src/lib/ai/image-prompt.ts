/**
 * Enriquecimiento de prompts de imagen para el turno natural del chat:
 *
 * 1. CONTEXTO: si el sujeto es vago ("genera una imagen del tema", "de eso que
 *    hablamos"), se resuelve el tema visual real con el historial reciente de
 *    la sesión usando el LLM del núcleo (rápido, con timeout corto y fallback
 *    heurístico al último turno del asistente).
 *
 * 2. WEB / MARCAS: si la petición menciona marcas, logotipos, empresas,
 *    lugares o "lo que esté en la web", se buscan referencias REALES
 *    (searchWebImages) y sus descripciones se inyectan en el prompt para que
 *    el generador refleje colores, rasgos y elementos característicos.
 *
 * 3. CALIDAD: sufijo de dirección de arte para todos los generadores (los
 *    iconos conservan su guía de estilo vectorial).
 */
import { isContextualSubject, WEB_GROUND_RE, type MediaIntent } from '@/lib/ai/image-intent'
import { searchWebImages } from '@/lib/ai/image-search'

export interface EnrichTurn {
  role: 'user' | 'assistant'
  content: string
}

const QUALITY_TAIL = 'alta calidad, composición profesional, iluminación cuidada, gran nivel de detalle'

const ICON_STYLE_TAIL =
  '— icono flat minimalista, estilo vectorial, trazos limpios, centrado, alto contraste, fondo liso y simple'

/** Resuelve un sujeto contextual ("del tema") en una frase visual concreta. */
async function resolveFromContext(
  userMessage: string,
  recentTurns: EnrichTurn[],
): Promise<string | null> {
  try {
    const transcript = recentTurns
      .slice(-6)
      .map((t) => `${t.role === 'user' ? 'Usuario' : 'Asistente'}: ${t.content.slice(0, 400)}`)
      .join('\n')
      .slice(0, 2400)

    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    const completion = (await Promise.race([
      zai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content:
              'Eres un director de arte. Con la conversación, describe el TEMA visual del que se habla en UNA sola frase descriptiva y concreta (máximo 220 caracteres, en español), lista para un generador de imágenes. Responde SOLO con esa frase, sin comillas ni explicaciones.',
          },
          {
            role: 'user',
            content: `Conversación reciente:\n${transcript}\n\nEl usuario pide: "${userMessage.slice(0, 200)}"\nDevuelve la frase visual del tema.`,
          },
        ],
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
    ])) as { choices?: Array<{ message?: { content?: string } }> } | null

    const text = completion?.choices?.[0]?.message?.content?.trim()
    return text && text.length > 3 ? text.slice(0, 240) : null
  } catch {
    return null
  }
}

export interface BuildImagePromptInput {
  intent: MediaIntent
  /** Mensaje original del usuario (para detectar marcas/web y el prompt contextual). */
  userMessage: string
  /** Últimos turnos de la sesión (excluye el mensaje actual), en orden cronológico. */
  recentTurns: EnrichTurn[]
}

export interface EnrichedImagePrompt {
  prompt: string
  /** true si se inyectaron referencias reales de la web. */
  webGrounded: boolean
  /** true si el sujeto vago se resolvió con el contexto de la conversación. */
  contextResolved: boolean
}

export async function buildImagePrompt(input: BuildImagePromptInput): Promise<EnrichedImagePrompt> {
  const { intent, userMessage, recentTurns } = input
  let core = intent.prompt
  let webGrounded = false
  let contextResolved = false

  // 1) Sujeto contextual → resolver con la conversación reciente.
  if (isContextualSubject(intent.subject) && recentTurns.length > 0) {
    const resolved = await resolveFromContext(userMessage, recentTurns)
    if (resolved) {
      core = resolved
      contextResolved = true
    }
  }

  // 2) Marcas / lugares / realidad → referencias reales de la web.
  if (WEB_GROUND_RE.test(userMessage) || WEB_GROUND_RE.test(core)) {
    try {
      const hits = await searchWebImages(intent.subject.slice(0, 120) || userMessage.slice(0, 120), 3)
      const notes = hits
        .map((h) => h.caption || h.source)
        .filter((v): v is string => Boolean(v))
        .slice(0, 3)
      if (notes.length > 0) {
        webGrounded = true
        core = `${core}. Referencias reales de la web: ${notes.join(' · ').slice(0, 300)}. Refleja con fidelidad los detalles, colores y elementos característicos descritos.`
      }
    } catch {
      // Sin grounding: el prompt base sigue siendo válido.
    }
  }

  // 3) Sufijo de dirección de arte (los iconos SIEMPRE conservan su guía).
  const prompt =
    intent.format === 'icon'
      ? core.includes('icono flat minimalista')
        ? core
        : `${core} ${ICON_STYLE_TAIL}`
      : `${core} — ${QUALITY_TAIL}`

  return { prompt: prompt.slice(0, 900), webGrounded, contextResolved }
}
