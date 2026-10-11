/**
 * Sonda 2: ¿OpenRouter acepta IDs mixtos (mayúsculas) del catálogo OE AI?
 * ¿Streaming SSE funciona correctamente?
 */
const BASE = 'https://openrouter.ai/api/v1'

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY no está configurada')
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'OE AI',
  }
}

async function main() {
  // 1) ID del catálogo con mayúsculas, sin mapear
  const mixed = 'meta-llama/Llama-3.1-8B-Instruct'
  const r1 = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: mixed, messages: [{ role: 'user', content: 'Responde solo: PONG' }], max_tokens: 200 }),
    cache: 'no-store',
  })
  console.log(`ID mixto ${mixed} → HTTP ${r1.status}`)
  if (r1.ok) {
    const d = (await r1.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> }
    console.log('  reportado:', d.model, '| contenido:', JSON.stringify(d.choices?.[0]?.message?.content?.slice(0, 60)))
  } else {
    console.log('  ', (await r1.text()).slice(0, 250))
  }

  await new Promise((r) => setTimeout(r, 3000))

  // 2) Streaming SSE real
  const r2 = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: 'Cuenta del 1 al 5, un número por línea.' }],
      max_tokens: 300,
      stream: true,
    }),
    cache: 'no-store',
  })
  console.log(`\nStreaming → HTTP ${r2.status}`)
  if (!r2.ok || !r2.body) {
    console.log((await r2.text()).slice(0, 250))
    return
  }
  const reader = r2.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let chunks = 0
  let assembled = ''
  let sawDone = false
  const t0 = Date.now()
  while (chunks < 50) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') {
        sawDone = true
        continue
      }
      try {
        const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }>; model?: string }
        const delta = json.choices?.[0]?.delta?.content
        if (delta) {
          chunks++
          assembled += delta
        }
        if (json.model) console.log('  stream model:', json.model)
      } catch {
        /* fragmento incompleto */
      }
    }
  }
  console.log(`  deltas con contenido: ${chunks} | [DONE]: ${sawDone} | ${Date.now() - t0}ms`)
  console.log('  texto ensamblado:', JSON.stringify(assembled.slice(0, 150)))
}

main().catch((e) => {
  console.error('Sonda falló:', e instanceof Error ? e.message : e)
  process.exit(1)
})
