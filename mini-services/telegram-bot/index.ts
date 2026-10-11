/**
 * OE AI — Bot de Telegram (puerto 3005)
 *
 * Mini-servicio sin dependencias externas (solo bun + fetch nativo).
 * Responde los mensajes de Telegram llamando a la API pública v1 del propio
 * proyecto OE AI (POST http://127.0.0.1:3000/api/v1/chat/completions con la
 * clave OE_AI_API_KEY del .env raíz), igual que haría cualquier cliente
 * estilo OpenAI.
 *
 * Comportamiento:
 *  - Sin TELEGRAM_BOT_TOKEN: imprime instrucciones claras en español y entra
 *    en modo espera (reintenta cada 30 s leyendo los .env). NUNCA crashea.
 *  - Con token: health-check HTTP en 3005 + long-polling infinito a getUpdates
 *    (timeout 25 s) con reintentos y retroceso ante fallos de red.
 *  - Comandos: /start (bienvenida), /reset (borra historial del chat).
 *  - Historial en memoria: Map<chatId, mensajes[]> con los últimos 12 mensajes.
 *  - Rate-limit básico: 1 petición a la API v1 por chat cada 2 s.
 *  - Respuestas sin parse_mode (texto plano), divididas en trozos de ≤4000 chars.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

/* ── Constantes ──────────────────────────────────────────────────────────── */

const PORT = 3005
const API_V1_URL = 'http://127.0.0.1:3000/api/v1/chat/completions'
const ROOT_ENV_PATH = '/home/z/my-project/.env'
const LOCAL_ENV_PATH = `${import.meta.dir}/.env`

const SYSTEM_PROMPT =
  'Eres OE AI. Responde SIEMPRE en español, con mensajes breves de Telegram (máx ~150 palabras), sin markdown complejo.'

/**
 * Ficha técnica oficial de OE AI (parámetros/capacidad). Se inyecta como
 * mensaje de sistema SOLO cuando el usuario pregunta por parámetros, tamaño,
 * capacidad o arquitectura de la red. Cifras canónicas: 128 modelos,
 * ~4×10¹² parámetros combinados, tres capas, enrutamiento elástico.
 */
const CAPACITY_DOC_BRIEF =
  'FICHA OFICIAL OE AI (parámetros/capacidad): OE AI no es un modelo estático, es un orquestador (Model Router) que unifica una red viva de 128 modelos. Capacidad combinada: ~4 billones de parámetros (4×10^12; "4 Trillion" en nomenclatura internacional), repartidos en tres capas: (1) Frontera/razonamiento complejo: arquitecturas MoE y densas de alta escala, como DeepSeek V3/R1 (671B) y gpt-oss-120b; (2) Intermedia/propósito general: 26B–70B (Llama/Hermes, Gemma 3/4, Aya, IBM Granite); (3) Flash/tareas ligeras: 3B–14B (GLM-Flash, AutoGLM-Phone, variantes destiladas). Escala dinámica: el sistema es elástico; el enrutador evalúa cada prompt y asigna la ruta óptima: consultas simples despiertan sub-redes de ~8B de parámetros, mientras que tareas complejas de código o lógica matemática despliegan cientos de miles de millones. La respuesta final se normaliza con los metadatos de la ruta (proveedor, modelo resuelto, fallback, latencia). Si el usuario pregunta por los parámetros/capacidad de OE AI, responde con estos datos en tono técnico, sin lenguaje comercial. Si habla de "parámetros" en otro contexto (p. ej. programación), responde con normalidad sin usar esta ficha.'

/** Normaliza texto: minúsculas, sin acentos, sin puntuación, espacios colapsados. */
function normalizeForMatch(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
}

/** true si el mensaje pregunta por los parámetros/capacidad/arquitectura de la red. */
function asksAboutCapacity(text: string): boolean {
  const norm = normalizeForMatch(text)
  const triggers = [
    'parametro',
    'parametros',
    'que tan grande',
    'cuan grande',
    'capacidad de computo',
    'capacidad de la red',
    'escala dinamica',
    'arquitectura del modelo',
    'arquitectura de la red',
    'mixture of experts',
    ' moe ',
    'model router',
    'orquestador',
    'cuantos modelos',
    'que modelo usas',
    'que modelo eres',
    'cual modelo usas',
    'red de modelos',
    '128 modelos',
    'how many parameters',
    'parameter count',
    'model size',
    'what model are you',
    'what model do you use',
  ]
  return triggers.some((t) => norm.includes(normalizeForMatch(t)))
}

const RATE_LIMIT_MS = 2_000 // 1 petición a la API v1 por chat cada 2 s
const HISTORY_LIMIT = 12 // últimos 12 mensajes enviados como contexto
const TELEGRAM_MAX_CHARS = 4000 // Telegram admite 4096; margen de seguridad
const POLL_TIMEOUT_S = 25 // long-polling de getUpdates
const RETRY_TOKEN_MS = 30_000 // relectura de .env cuando falta el token

/* ── Tipos mínimos de Telegram / API v1 ─────────────────────────────────── */

interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}
interface TgChat {
  id: number
  type: string
}
interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  text?: string
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
}
interface TgResult<T> {
  ok: boolean
  result: T
  description?: string
  error_code?: number
}
interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}
interface V1Response {
  choices?: Array<{ message?: { role?: string; content?: string } }>
  error?: { code?: string; message?: string }
}

/* ── Utilidades ─────────────────────────────────────────────────────────── */

function log(...args: unknown[]) {
  console.log(`[tg-bot ${new Date().toISOString()}]`, ...args)
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/* ── Entorno: .env raíz + .env propio del bot (mismo enfoque loadRootEnv) ── */

function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await Bun.file(path).text())
  } catch {
    return {}
  }
}

/** Carga el .env raíz (prioriza variables ya presentes en el proceso). */
async function loadRootEnv() {
  const rootEnv = await readEnvFile(ROOT_ENV_PATH)
  for (const [k, v] of Object.entries(rootEnv)) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}

/**
 * Token de Telegram con prioridad:
 *   1) mini-services/telegram-bot/.env (archivo específico del bot; se relee
 *      en cada llamada, así que el propietario puede crearlo sin reiniciar),
 *   2) variable de proceso,
 *   3) .env raíz.
 */
async function getTelegramToken(): Promise<string | null> {
  const local = (await readEnvFile(LOCAL_ENV_PATH)).TELEGRAM_BOT_TOKEN?.trim()
  if (local) return local
  const proc = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (proc) return proc
  const root = (await readEnvFile(ROOT_ENV_PATH)).TELEGRAM_BOT_TOKEN?.trim()
  return root || null
}

/** Clave de la API v1: variable de proceso primero, si no el .env raíz. */
async function getApiKey(): Promise<string | null> {
  const proc = process.env.OE_AI_API_KEY?.trim()
  if (proc) return proc
  const root = (await readEnvFile(ROOT_ENV_PATH)).OE_AI_API_KEY?.trim()
  return root || null
}

/* ── Estado en memoria ──────────────────────────────────────────────────── */

let currentToken: string | null = null
let botUsername: string | null = null

const history = new Map<number, ChatMsg[]>() // chatId → últimos mensajes
const lastApiAt = new Map<number, number>() // chatId → ts de la última llamada
const inFlight = new Set<number>() // chats con una petición en curso

/* ── Ciclo de vida seguro ante recargas de `bun --hot` ──────────────────── */

interface Lifecycle {
  generation: number
  server?: ReturnType<typeof createServer>
}
const LIFECYCLE_KEY = '__oeTgBotLifecycle'

function lifecycle(): Lifecycle {
  const g = globalThis as Record<string, unknown>
  if (!g[LIFECYCLE_KEY]) g[LIFECYCLE_KEY] = { generation: 0 }
  return g[LIFECYCLE_KEY] as Lifecycle
}

// Cada evaluación del módulo (arranque o hot-reload) incrementa la generación:
// las instancias viejas detectan que quedaron obsoletas y se retiran solas.
const GENERATION = lifecycle().generation + 1
lifecycle().generation = GENERATION

function stale(): boolean {
  return lifecycle().generation !== GENERATION
}

/* ── API de Telegram ────────────────────────────────────────────────────── */

async function tg<T>(method: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  if (!currentToken) throw new Error('sin TELEGRAM_BOT_TOKEN')
  const res = await fetch(`https://api.telegram.org/bot${currentToken}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const data = (await res.json().catch(() => ({}))) as TgResult<T>
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} → HTTP ${res.status} ${data.description ?? '(sin detalle)'}`)
  }
  return data.result
}

/** Envía texto sin parse_mode (Telegram lo muestra tal cual), troceado a ≤4000. */
function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

async function sendText(chatId: number, text: string) {
  for (const chunk of splitText(text, TELEGRAM_MAX_CHARS)) {
    try {
      await tg('sendMessage', { chat_id: chatId, text: chunk })
    } catch (err) {
      log(`sendMessage falló para el chat ${chatId}: ${describeError(err)}`)
    }
  }
}

/* ── Llamada a la API v1 del propio proyecto ────────────────────────────── */

async function answerWithAI(chatId: number, text: string) {
  // Rate-limit básico: si ya hay una petición en curso → aviso; si la última
  // fue hace <2 s, esperamos el resto del intervalo antes de disparar.
  if (inFlight.has(chatId)) {
    await sendText(chatId, 'Espera un momento…')
    return
  }
  const elapsed = Date.now() - (lastApiAt.get(chatId) ?? 0)
  if (elapsed < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - elapsed)
  lastApiAt.set(chatId, Date.now())
  inFlight.add(chatId)

  try {
    const apiKey = await getApiKey()
    if (!apiKey) {
      await sendText(
        chatId,
        '⚠️ El servidor no tiene configurada la clave de la API (OE_AI_API_KEY en el .env raíz). El propietario debe añadirla para que pueda responder.',
      )
      return
    }

    const hist = history.get(chatId) ?? []
    const messages: ChatMsg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(asksAboutCapacity(text) ? [{ role: 'system' as const, content: CAPACITY_DOC_BRIEF }] : []),
      ...hist.slice(-HISTORY_LIMIT),
      { role: 'user', content: text },
    ]

    const res = await fetch(API_V1_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages, stream: false }),
      signal: AbortSignal.timeout(90_000),
    })

    const data = (await res.json().catch(() => ({}))) as V1Response

    if (!res.ok) {
      const code = data.error?.code ?? `HTTP ${res.status}`
      log(`API v1 rechazó la petición (${code}): ${data.error?.message ?? 'sin detalle'}`)
      const friendly =
        res.status === 401
          ? '🔑 La clave de la API fue rechazada (401). El propietario debe revisar OE_AI_API_KEY en el .env raíz.'
          : res.status === 429
            ? '⏳ La API está saturada ahora mismo. Prueba de nuevo en unos segundos.'
            : `❌ No pude obtener respuesta de OE AI (${code}). Inténtalo de nuevo en un momento.`
      await sendText(chatId, friendly)
      return
    }

    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      log('API v1 respondió sin contenido utilizable')
      await sendText(chatId, '🤔 La API respondió sin contenido. Inténtalo de nuevo.')
      return
    }

    history.set(chatId, [...hist, { role: 'user', content: text }, { role: 'assistant', content }].slice(-HISTORY_LIMIT))
    await sendText(chatId, content)
  } catch (err) {
    log(`Fallo llamando a la API v1: ${describeError(err)}`)
    await sendText(chatId, '❌ No pude contactar con la API de OE AI. Inténtalo de nuevo en un momento.')
  } finally {
    inFlight.delete(chatId)
  }
}

/* ── Actualizaciones de Telegram ────────────────────────────────────────── */

const WELCOME = [
  '👋 ¡Hola! Soy OE AI, el asistente de la plataforma OE AI LLM.',
  '',
  'Escríbeme lo que necesites en español: preguntas, ideas, resúmenes, código…',
  '',
  'Comandos:',
  '/reset — borra el historial de este chat y empezamos de cero.',
  '',
  'Mis respuestas salen de la API v1 del propio proyecto OE AI (modelo auto).',
].join('\n')

async function handleUpdate(update: TgUpdate) {
  const msg = update.message
  if (!msg) return // ignoramos edited_message, callback_query, etc.
  if (msg.from?.is_bot) return // nunca responder a otros bots ni a nosotros
  const text = msg.text?.trim()
  if (!text) return
  const chatId = msg.chat.id

  if (text === '/start' || text.startsWith('/start@') || text.startsWith('/start ')) {
    await sendText(chatId, WELCOME)
    return
  }
  if (text === '/reset' || text.startsWith('/reset@') || text.startsWith('/reset ')) {
    history.delete(chatId)
    await sendText(chatId, '🧹 Historial borrado. Empezamos de cero.')
    return
  }
  if (text.startsWith('/')) {
    await sendText(chatId, 'No conozco ese comando. Escríbeme tu pregunta directamente o usa /start.')
    return
  }

  await answerWithAI(chatId, text)
}

/* ── Long-polling infinito (nunca crashea) ──────────────────────────────── */

async function syncToken(): Promise<boolean> {
  const token = await getTelegramToken()
  if (!token || token === currentToken) return false
  currentToken = token
  log('TELEGRAM_BOT_TOKEN (nuevo o actualizado) tomado de los .env.')
  try {
    const me = await tg<TgUser>('getMe', undefined, 15_000)
    botUsername = me.username ?? null
    log(`Conectado a Telegram como @${me.username ?? me.id}.`)
  } catch (err) {
    botUsername = null
    log(`Aviso: getMe falló (${describeError(err)}). El polling lo reintentará; el health-check sigue activo.`)
  }
  return true
}

async function pollLoop() {
  let offset = 0
  const allowed = encodeURIComponent(JSON.stringify(['message']))
  while (true) {
    if (stale()) return // una recarga de --hot dejó esta instancia obsoleta
    try {
      const url = `https://api.telegram.org/bot${currentToken}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}&allowed_updates=${allowed}`
      const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000) })
      const data = (await res.json().catch(() => ({}))) as TgResult<TgUpdate[]>

      if (!res.ok || !data.ok) {
        const desc = data.description ?? `(HTTP ${res.status})`
        if (res.status === 401 || data.error_code === 401) {
          log(`Telegram rechazó el token (401). Revisa TELEGRAM_BOT_TOKEN. Reintento en 30 s. Detalle: ${desc}`)
          await sleep(30_000)
          await syncToken() // por si el propietario acabó de arreglar/rotar el token
        } else if (res.status === 409) {
          log('Otro proceso ya está consultando getUpdates con este token (409). Reintento en 10 s.')
          await sleep(10_000)
        } else {
          log(`getUpdates falló: ${desc}. Reintento en 5 s.`)
          await sleep(5_000)
        }
        continue
      }

      for (const update of data.result ?? []) {
        offset = Math.max(offset, update.update_id + 1)
        try {
          await handleUpdate(update)
        } catch (err) {
          log(`Error procesando el update ${update.update_id}: ${describeError(err)}`)
        }
      }
    } catch (err) {
      log(`Fallo de red en getUpdates: ${describeError(err)}. Espero 5 s y sigo.`)
      await sleep(5_000)
      await syncToken() // por si el token apareció/cambió mientras no había red
    }
  }
}

/* ── Health-check HTTP en el puerto 3005 ────────────────────────────────── */

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function startHttpServer() {
  // Si una recarga de --hot dejó un servidor de una generación anterior, se
  // cierra para que esta instancia tome el puerto sin EADDRINUSE.
  const previous = lifecycle().server
  if (previous && previous.listening) {
    try {
      previous.close()
      previous.closeAllConnections?.()
    } catch {
      // nada crítico: si no se pudo cerrar, el reintento de abajo lo cubre
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      json(res, 200, { ok: true, bot: botUsername !== null, username: botUsername })
      return
    }
    json(res, 404, { ok: false, error: 'not_found' })
  })
  lifecycle().server = server
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`El puerto ${PORT} ya está en uso. Reintento en 5 s…`)
      setTimeout(() => {
        if (stale()) return
        server.close()
        server.listen(PORT)
      }, 5_000)
      return
    }
    log(`Error del servidor HTTP: ${describeError(err)}`)
  })
  server.listen(PORT, () => {
    log(`Health-check disponible en http://127.0.0.1:${PORT}/`)
  })
}

/* ── Instrucciones cuando falta el token ────────────────────────────────── */

function printTokenInstructions() {
  console.log(`
────────────────────────────────────────────────────────────────
  FALTA TELEGRAM_BOT_TOKEN — el bot de OE AI no puede conectarse
────────────────────────────────────────────────────────────────
Cómo crear tu bot (2 minutos):
 1. Abre Telegram y busca @BotFather (cuenta verificada).
 2. Envía /newbot y sigue los pasos: nombre visible y un nombre de
    usuario que termine en "bot" (p. ej. MiOEBot).
 3. BotFather te dará un token con forma 123456789:AA…; cópialo COMPLETO.
 4. Pégalo en UNO de estos sitios:
    • Recomendado: crea el archivo mini-services/telegram-bot/.env
      con esta línea:
        TELEGRAM_BOT_TOKEN=123456789:AA...
    • Alternativa: añade la misma línea al .env raíz del proyecto
      (/home/z/my-project/.env).
 5. No hace falta reiniciar nada: este proceso relee los .env cada
    30 s (y, si usas "bun run dev", el --hot también recarga al editar).

Mientras tanto: el bot queda en modo espera y el health-check sigue
activo en http://127.0.0.1:${PORT}/ → {"ok":true,"bot":false}
────────────────────────────────────────────────────────────────`)
}

/* ── Arranque ───────────────────────────────────────────────────────────── */

async function main() {
  await loadRootEnv()
  startHttpServer()

  let instruccionesMostradas = false
  while (true) {
    if (stale()) return // recarga de --hot: la nueva instancia toma el mando
    const token = await getTelegramToken()
    if (token) {
      currentToken = token
      log('TELEGRAM_BOT_TOKEN encontrado. Arrancando bot…')
      try {
        const me = await tg<TgUser>('getMe', undefined, 15_000)
        botUsername = me.username ?? null
        log(`Conectado a Telegram como @${me.username ?? me.id}. Long-polling activo.`)
      } catch (err) {
        log(`Aviso: getMe falló (${describeError(err)}). El polling lo reintentará; el health-check sigue activo.`)
      }
      await pollLoop() // bucle infinito; nunca debería salir
      return
    }
    if (!instruccionesMostradas) {
      printTokenInstructions()
      instruccionesMostradas = true
    } else {
      log(`Sin TELEGRAM_BOT_TOKEN todavía; sigo esperando (relectura de .env cada ${RETRY_TOKEN_MS / 1000} s)…`)
    }
    await sleep(RETRY_TOKEN_MS)
  }
}

main().catch((err) => {
  // Defensa final: el servicio no debe morir jamás por un error de arranque.
  if (stale()) return
  log(`Error fatal inesperado en el arranque: ${describeError(err)}. Reintento en 30 s.`)
  setTimeout(() => {
    if (!stale()) main().catch(() => process.exit(1))
  }, 30_000)
})
