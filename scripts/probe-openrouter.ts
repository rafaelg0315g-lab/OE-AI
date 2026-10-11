/**
 * Sonda REAL de OpenRouter para OE AI.
 * 1) Descarga el catálogo vivo de OpenRouter (GET /api/v1/models).
 * 2) Cruza con los 128 IDs fuente del catálogo OE AI (coincidencia exacta y normalizada).
 * 3) Prueba un chat completion real con 3 IDs del catálogo presentes en OpenRouter.
 * Nunca imprime la clave. No simula nada: solo reporta lo que responde la API.
 */
import { SOURCE_MODEL_IDS } from '../src/lib/ai/catalog/models.data'

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
  // --- 1. Catálogo vivo ---
  const res = await fetch(`${BASE}/models`, { headers: headers(), cache: 'no-store' })
  console.log('GET /models →', res.status)
  if (!res.ok) {
    console.log(await res.text())
    return
  }
  const data = (await res.json()) as {
    data?: Array<{ id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }>
  }
  const live = data.data ?? []
  const liveIds = new Set(live.map((m) => m.id))
  console.log('Modelos vivos en OpenRouter:', live.length)

  // --- 2. Cruce con el catálogo OE AI (exacto y normalizado minúsculas) ---
  const exact = SOURCE_MODEL_IDS.filter((id) => liveIds.has(id))
  const lowerMap = new Map<string, string>()
  for (const id of liveIds) lowerMap.set(id.toLowerCase(), id)
  const normalized: Array<{ oe: string; live: string }> = []
  for (const oe of SOURCE_MODEL_IDS) {
    if (liveIds.has(oe)) continue
    const hit = lowerMap.get(oe.toLowerCase())
    if (hit) normalized.push({ oe, live: hit })
  }
  console.log('\n== Coincidencias EXACTAS con catálogo OE AI ==', exact.length)
  for (const id of exact) console.log('  •', id)
  console.log('\n== Coincidencias por minúsculas (ID difiere en mayúsculas) ==', normalized.length)
  for (const n of normalized) console.log(`  • OE: ${n.oe}  ⇄  OpenRouter: ${n.live}`)

  // --- 3. Prueba real de chat con hasta 3 coincidencias exactas ---
  const candidates = exact.slice(0, 3)
  for (const model of candidates) {
    const t0 = Date.now()
    try {
      const chat = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Responde únicamente: PONG' }],
          max_tokens: 300,
        }),
        cache: 'no-store',
      })
      const ms = Date.now() - t0
      if (!chat.ok) {
        console.log(`\nCHAT ${model} → HTTP ${chat.status} (${ms}ms):`, (await chat.text()).slice(0, 300))
        continue
      }
      const payload = (await chat.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        model?: string
        usage?: { total_tokens?: number }
      }
      console.log(
        `\nCHAT ${model} → OK (${ms}ms) reportado=${payload.model} tokens=${payload.usage?.total_tokens ?? '?'}`,
      )
      console.log('  contenido:', JSON.stringify(payload.choices?.[0]?.message?.content?.slice(0, 120)))
    } catch (err) {
      console.log(`\nCHAT ${model} → EXCEPCIÓN:`, err instanceof Error ? err.message : err)
    }
  }
}

main().catch((e) => {
  console.error('Sonda falló:', e instanceof Error ? e.message : e)
  process.exit(1)
})
