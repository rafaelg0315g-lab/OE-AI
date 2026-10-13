/**
 * Generador de SVG por LLM (formato vectorial solicitado explícitamente).
 *
 * Cuando el usuario pide "un icono en SVG" / "un logo SVG", no se genera un
 * PNG: se pide al modelo que produzca código SVG válido y autocontenido.
 * Cascada de texto: núcleo z-ai → Gemini directo → OpenRouter.
 * Devuelve el código más limpio posible (se extrae el elemento <svg> raíz).
 */

import type { NormalizedCompletion } from '@/lib/ai/types'
import { GEMINI_DIRECT_ROUTE, createGeminiDirectMiniAdapter } from '@/lib/ai/gemini-direct'
import { providerRegistry } from '@/lib/ai/providers'

const SVG_SYSTEM =
  'Eres un diseñador SVG experto. Genera UNICAMENTE código SVG válido, completo y autocontenido ' +
  '(empieza por <svg y termina por </svg>). Sin explicaciones, sin markdown, sin bloques de código, sin comentarios. ' +
  'Reglas: incluye viewBox y xmlns; usa formas, paths, gradientes y colores sólidos de buen contraste; ' +
  'diseño limpio y moderno, centrado, que escale bien a cualquier tamaño; fondo transparente salvo que se pida lo contrario. ' +
  'Si el sujeto es un icono o logo, estilo flat minimalista con trazos claros.'

/** Intenta un proveedor de texto y devuelve su contenido normalizado. */
async function tryProvider(
  run: () => Promise<NormalizedCompletion>,
): Promise<NormalizedCompletion> {
  return run()
}

/** Extrae el elemento <svg>…</svg> de una respuesta del modelo. */
export function extractSvgCode(raw: string): string | null {
  if (!raw) return null
  // Quitar vallas markdown si el modelo las añadió pese a las instrucciones.
  let text = raw.trim().replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim()
  const start = text.search(/<svg[\s>]/i)
  if (start === -1) return null
  const end = text.toLowerCase().lastIndexOf('</svg>')
  if (end === -1) return null
  text = text.slice(start, end + 6).trim()
  // Sanidad mínima: viewBox presente (el render escala con él) y tamaño razonable.
  if (!/viewBox=/i.test(text)) return null
  if (text.length > 60_000) return null
  return text
}

export interface SvgOutcome {
  code: string
  providerId: string
  providerReportedModel: string | null
  latencyMs: number
}

/** Genera código SVG con la cascada de texto. Lanza si ningún proveedor produce SVG válido. */
export async function generateSvgCode(subject: string): Promise<SvgOutcome> {
  const userPrompt = `Crea un SVG para: ${subject}`.slice(0, 900)
  const errors: string[] = []

  // 1) Núcleo z-ai
  const zaiAdapter = providerRegistry.get('zai-org')
  if (zaiAdapter) {
    try {
      const completion = await tryProvider(() =>
        zaiAdapter.chat({
          messages: [
            { role: 'system' as const, content: SVG_SYSTEM },
            { role: 'user' as const, content: userPrompt },
          ],
          providerModelId: 'default',
        }),
      )
      const code = extractSvgCode(completion.content)
      if (code) {
        return { code, providerId: 'zai-org', providerReportedModel: completion.providerReportedModel, latencyMs: completion.latencyMs }
      }
      errors.push('z-ai: sin <svg> válido')
    } catch (err) {
      errors.push(`z-ai: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`)
    }
  }

  // 2) Gemini directo
  if (process.env.GEMINI_API_KEY?.trim()) {
    try {
      const geminiAdapter = createGeminiDirectMiniAdapter()
      const completion = await geminiAdapter.chat({
        messages: [
          { role: 'system' as const, content: SVG_SYSTEM },
          { role: 'user' as const, content: userPrompt },
        ],
        providerModelId: GEMINI_DIRECT_ROUTE.providerModelId,
      })
      const code = extractSvgCode(completion.content)
      if (code) {
        return { code, providerId: 'gemini-direct', providerReportedModel: completion.providerReportedModel, latencyMs: completion.latencyMs }
      }
      errors.push('gemini: sin <svg> válido')
    } catch (err) {
      errors.push(`gemini: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`)
    }
  }

  // 3) OpenRouter (primera ruta disponible y verificada si hay health checks)
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    try {
      const orRoutes = providerRegistry.availableRoutes().filter((r) => r.providerId === 'openrouter')
      if (orRoutes.length > 0) {
        const orAdapter = providerRegistry.get('openrouter')
        if (orAdapter) {
          const completion = await orAdapter.chat({
            messages: [
              { role: 'system' as const, content: SVG_SYSTEM },
              { role: 'user' as const, content: userPrompt },
            ],
            providerModelId: orRoutes[0].providerModelId,
          })
          const code = extractSvgCode(completion.content)
          if (code) {
            return { code, providerId: 'openrouter', providerReportedModel: completion.providerReportedModel, latencyMs: completion.latencyMs }
          }
          errors.push('openrouter: sin <svg> válido')
        }
      }
    } catch (err) {
      errors.push(`openrouter: ${err instanceof Error ? err.message.slice(0, 100) : 'error'}`)
    }
  }

  throw new Error(`Ningún proveedor pudo generar el SVG (${errors.join(' · ')}).`)
}
