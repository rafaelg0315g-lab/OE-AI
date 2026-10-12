/**
 * Cascada de GENERACIÓN DE IMAGEN compartida (política de despliegue de OE AI):
 * 1) z-ai (núcleo del sandbox)
 * 2) Gemini directo (AI Studio; producción, p. ej. Vercel)
 * 3) OpenRouter (modelos de imagen con la key del propietario)
 * 4) Pollinations (gratuita, sin clave)
 *
 * Gana el primero que devuelva una imagen utilizable. Usada por
 * /api/tools/image (botón del compositor) y por el turno de chat con
 * intención de imagen (/api/chat, detección natural).
 */

export interface ImageCascadeInput {
  prompt: string
  /** Tamaños aceptados por el proveedor de imágenes (mismo enum en toda la app). */
  size: '1024x1024' | '768x1344' | '864x1152' | '1344x768' | '1152x864' | '1440x720' | '720x1440'
  /** Modelos OpenRouter con modalidad de imagen, en orden de prueba. */
  openRouterModels?: string[]
}

export interface ImageCascadeOutcome {
  buffer: Buffer
  mime: string
  providerId: string
  reportedModel: string
}

/** Modelos de imagen por defecto en OpenRouter (verificados en vivo). */
const DEFAULT_OR_IMAGE_MODELS = [
  'google/gemini-2.5-flash-image',
  'google/gemini-3.1-flash-image',
  'openai/gpt-5-image-mini',
]

/** Sniff básico de MIME a partir de la firma del buffer. */
export function sniffImageMime(buffer: Buffer): string {
  if (buffer.length > 3 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length > 11 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return 'image/png'
}

export async function generateImageWithCascade(input: ImageCascadeInput): Promise<ImageCascadeOutcome> {
  const prompt = input.prompt.trim()
  const orModels = input.openRouterModels ?? DEFAULT_OR_IMAGE_MODELS

  const generators: Array<{ id: string; run: () => Promise<ImageCascadeOutcome> }> = [
    {
      id: 'zai-org',
      run: async () => {
        const { default: ZAI } = await import('z-ai-web-dev-sdk')
        const zai = await ZAI.create()
        const result = await zai.images.generations.create({ prompt, size: input.size })
        const base64 = result?.data?.[0]?.base64
        if (!base64) throw new Error('El proveedor de imágenes no devolvió datos utilizables.')
        const buffer = Buffer.from(base64, 'base64')
        return { buffer, mime: sniffImageMime(buffer), providerId: 'zai-org', reportedModel: 'image-generation' }
      },
    },
    {
      id: 'gemini-direct',
      run: async () => {
        const { geminiImageGenerate } = await import('@/lib/ai/gemini-direct')
        const img = await geminiImageGenerate(prompt, input.size)
        return { buffer: img.buffer, mime: sniffImageMime(img.buffer), providerId: 'gemini-direct', reportedModel: img.model }
      },
    },
    {
      id: 'openrouter',
      run: async () => {
        const key = process.env.OPENROUTER_API_KEY?.trim()
        if (!key) throw new Error('OPENROUTER_API_KEY no configurada.')
        let lastErr = 'sin intentos'
        for (const model of orModels) {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              modalities: ['image', 'text'],
              messages: [{ role: 'user', content: prompt.slice(0, 900) }],
            }),
            signal: AbortSignal.timeout(120_000),
          })
          const data = (await res.json().catch(() => null)) as {
            error?: { message?: string }
            choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>
          } | null
          const dataUrl = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url
          if (res.ok && dataUrl) {
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
            const buffer = Buffer.from(base64, 'base64')
            if (buffer.byteLength) {
              return { buffer, mime: sniffImageMime(buffer), providerId: 'openrouter', reportedModel: model }
            }
          }
          lastErr = data?.error?.message?.slice(0, 140) || `HTTP ${res.status}`
          // 402 (sin créditos) / 403 (geo): probar el siguiente modelo.
        }
        throw new Error(`OpenRouter sin imagen: ${lastErr}`)
      },
    },
    {
      id: 'pollinations',
      run: async () => {
        const [w, h] = input.size.split('x').map((n) => Number.parseInt(n, 10) || 1024)
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}?width=${w}&height=${h}&nologo=true&model=flux`
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
        if (!res.ok) throw new Error(`Pollinations HTTP ${res.status}`)
        const buffer = Buffer.from(await res.arrayBuffer())
        if (!buffer.byteLength) throw new Error('Pollinations devolvió una imagen vacía.')
        return { buffer, mime: sniffImageMime(buffer), providerId: 'pollinations', reportedModel: 'flux' }
      },
    },
  ]

  let lastError: unknown = null
  for (const generator of generators) {
    try {
      const outcome = await generator.run()
      if (generator.id !== 'zai-org') {
        console.warn(`[ai/image-cascade] generada con respaldo ${generator.id}`)
      }
      return outcome
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Ningún proveedor de imágenes disponible.')
}
