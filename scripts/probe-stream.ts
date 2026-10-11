/** Sonda aislada de streaming (1 petición). */
import ZAI from 'z-ai-web-dev-sdk'

async function main() {
  const started = Date.now()
  try {
    const zai = await ZAI.create()
    const result = await zai.chat.completions.create({
      messages: [{ role: 'user', content: 'Di solo: hola' }],
      stream: true,
      thinking: { type: 'disabled' },
    } as never)
    const iterable = result as unknown as AsyncIterable<unknown>
    const hasIterator =
      iterable && typeof (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
    if (!hasIterator) {
      // @ts-expect-error - estructura dinámica
      console.log('[stream] NO_ITERABLE | respuesta normal:', JSON.stringify(String(result?.choices?.[0]?.message?.content ?? '').slice(0, 80)))
      return
    }
    let chunks = 0
    let text = ''
    for await (const part of iterable) {
      chunks++
      // @ts-expect-error - estructura dinámica
      text += String(part?.choices?.[0]?.delta?.content ?? '')
      if (chunks > 100) break
    }
    console.log(`[stream] OK | chunks=${chunks} | ${Date.now() - started}ms | text=${JSON.stringify(text.slice(0, 80))}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[stream] ERROR ${Date.now() - started}ms | ${msg.slice(0, 200)}`)
  }
}

main()
