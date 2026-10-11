/**
 * Sonda de capacidades reales del SDK z-ai-web-dev-sdk.
 * Objetivo (máx ~7 peticiones pequeñas):
 *  1. Confirmar que el SDK funciona (petición base).
 *  2. Comprobar si el parámetro `model` se acepta y se VALIDA
 *     (un nombre inválido debe fallar si hay enrutamiento real).
 *  3. Comprobar soporte de streaming.
 */
import ZAI from 'z-ai-web-dev-sdk'

const QUESTION = 'Responde exactamente con la palabra: PONG'

async function tryCreate(label: string, params: Record<string, unknown>): Promise<void> {
  const started = Date.now()
  try {
    const zai = await ZAI.create()
    const completion = await Promise.race([
      zai.chat.completions.create(params as never),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT_30s')), 30000)
      ),
    ])
    // @ts-expect-error - respuesta dinámica
    const content = completion?.choices?.[0]?.message?.content
    // @ts-expect-error - respuesta dinámica
    const model = completion?.model ?? completion?.choices?.[0]?.model ?? '(sin campo model)'
    console.log(`[${label}] OK en ${Date.now() - started}ms | model=${JSON.stringify(model)} | content=${JSON.stringify(String(content ?? '').slice(0, 80))}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[${label}] ERROR en ${Date.now() - started}ms | ${msg.slice(0, 300)}`)
  }
}

async function tryStream(): Promise<void> {
  const started = Date.now()
  try {
    const zai = await ZAI.create()
    const result = await Promise.race([
      zai.chat.completions.create({
        messages: [{ role: 'user', content: 'Cuenta del 1 al 5, solo números separados por espacios' }],
        stream: true,
        thinking: { type: 'disabled' },
      } as never),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT_30s')), 30000)
      ),
    ])
    // Intentar iterar como stream
    const iterable = result as unknown as AsyncIterable<unknown>
    if (iterable && typeof (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
      let chunks = 0
      let text = ''
      for await (const part of iterable) {
        chunks++
        // @ts-expect-error - estructura dinámica
        const delta = part?.choices?.[0]?.delta?.content ?? ''
        text += String(delta ?? '')
        if (chunks > 60) break
      }
      console.log(`[stream] OK stream=true en ${Date.now() - started}ms | chunks=${chunks} | text=${JSON.stringify(text.slice(0, 60))}`)
    } else {
      // @ts-expect-error - estructura dinámica
      const content = result?.choices?.[0]?.message?.content
      console.log(`[stream] NO_ITERABLE en ${Date.now() - started}ms | devolvió respuesta normal: ${JSON.stringify(String(content ?? '').slice(0, 60))}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[stream] ERROR en ${Date.now() - started}ms | ${msg.slice(0, 300)}`)
  }
}

async function main() {
  console.log('--- Sonda z-ai-web-dev-sdk ---')
  await tryCreate('base (sin model)', {
    messages: [{ role: 'user', content: QUESTION }],
    thinking: { type: 'disabled' },
  })
  await tryCreate('model=zai-org/GLM-5.3-Flash', {
    messages: [{ role: 'user', content: QUESTION }],
    model: 'zai-org/GLM-5.3-Flash',
    thinking: { type: 'disabled' },
  })
  await tryCreate('model=GLM-5.3-Flash', {
    messages: [{ role: 'user', content: QUESTION }],
    model: 'GLM-5.3-Flash',
    thinking: { type: 'disabled' },
  })
  await tryCreate('model=NOMBRE-INEXISTENTE-XYZ', {
    messages: [{ role: 'user', content: QUESTION }],
    model: 'NOMBRE-INEXISTENTE-XYZ-123',
    thinking: { type: 'disabled' },
  })
  await tryCreate('model=glm-4.5-flash', {
    messages: [{ role: 'user', content: QUESTION }],
    model: 'glm-4.5-flash',
    thinking: { type: 'disabled' },
  })
  await tryStream()
  console.log('--- Fin sonda ---')
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Fallo fatal de la sonda:', e)
  process.exit(1)
})
