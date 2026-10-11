/** Sonda de forma del chunk de streaming (1 petición). */
import ZAI from 'z-ai-web-dev-sdk'

async function main() {
  const zai = await ZAI.create()
  const result = await zai.chat.completions.create({
    messages: [{ role: 'user', content: 'Di solo: hola' }],
    stream: true,
    thinking: { type: 'disabled' },
  } as never)
  for await (const part of result as unknown as AsyncIterable<unknown>) {
    console.log('CHUNK:', JSON.stringify(part).slice(0, 600))
  }
}

main()
