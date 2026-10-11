import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'
import { consumeGuestChat, guestCookieHeader, resolveChatIdentity } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'
// El render con JSON2Video suele tardar 30-150 s; el sondeo deja margen amplio.
export const maxDuration = 480

/** Tamaños soportados realmente por el proveedor de vídeo (incluye 1080p). */
const SUPPORTED_SIZES = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
  '1920x1080',
] as const

const POLL_INTERVAL_MS = 6_000
const MAX_POLL_ATTEMPTS = 70 // ~7 minutos de sondeo
const MAX_VIDEO_BYTES = 100 * 1024 * 1024 // 100 MB: cota de seguridad al descargar
/**
 * Si JSON2Video falla todavía con presupuesto de tiempo amplio, el turno se
 * respalda con el proveedor z-ai. Pasado ese umbral se devuelve un error
 * honesto (ya no queda tiempo útil para un segundo render).
 */
const FALLBACK_BUDGET_MS = 100_000

/* ── JSON2Video (proveedor principal: video narrado con voz IA) ──────────── */
const J2V_API = 'https://api.json2video.com/v2'
const J2V_TEMPLATE = process.env.JSON2VIDEO_TEMPLATE_ID || '2QzqAMLjKkS7dpgUupmI'
const J2V_VOICE = process.env.JSON2VIDEO_VOICE || 'en-US-NovaTurboMultilingualNeural'

const VideoBodySchema = z.object({
  prompt: z.string().min(1).max(800),
  size: z.enum(SUPPORTED_SIZES).optional().default('1024x1024'),
  duration: z.union([z.literal(5), z.literal(10)]).optional().default(5),
  withAudio: z.boolean().optional().default(false),
  /** Conversación destino (paridad con /api/tools/image): si llega, el turno
   *  (usuario + resultado) se persiste en el historial del chat. */
  sessionId: z.string().uuid().optional(),
})

type VideoTaskStatus = 'PROCESSING' | 'SUCCESS' | 'FAIL'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Extrae la URL del vídeo de la respuesta del sondeo z-ai (formatos conocidos). */
function extractVideoUrl(result: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    (result as { video_result?: Array<{ url?: string }> }).video_result?.[0]?.url,
    (result as { video_url?: string }).video_url,
    (result as { url?: string }).url,
    (result as { video?: string }).video,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('http')) return c
  }
  return null
}

/* ════════════════════════ JSON2Video · helpers ═══════════════════════════ */

async function j2vRequest(apiKey: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${J2V_API}${path}`, {
    ...init,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !data) {
    throw new Error(`JSON2Video ${path} respondió HTTP ${res.status}.`)
  }
  return data
}

/**
 * Sube un PNG a la biblioteca de medios de JSON2Video (carpeta "temp", con
 * auto-limpieza) mediante URL presignada y devuelve su URL pública, que es lo
 * que el render necesita para descargar la imagen.
 */
async function uploadPngToJ2v(apiKey: string, buffer: Buffer, index: number): Promise<string> {
  const name = `oe-ai-${Date.now()}-${index + 1}.png`
  const presign = (await j2vRequest(apiKey, '/media/file', {
    method: 'POST',
    body: JSON.stringify({ name, contentType: 'image/png', size: buffer.byteLength, folder: 'temp' }),
  })) as { uploadUrl?: string; fileUrl?: string }
  if (!presign.uploadUrl || !presign.fileUrl) {
    throw new Error('JSON2Video no entregó la URL de subida de medios.')
  }
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    body: new Uint8Array(buffer),
    headers: { 'Content-Type': 'image/png' },
  })
  if (!put.ok) {
    throw new Error(`La subida de imágenes a JSON2Video falló (HTTP ${put.status}).`)
  }
  // El registro confirma la subida asíncronamente: se verifica que la URL
  // pública responde antes de usarla en el guion (3 intentos, 1,5 s).
  for (let attempt = 0; attempt < 3; attempt++) {
    const check = await fetch(presign.fileUrl, { method: 'HEAD', cache: 'no-store' }).catch(() => null)
    if (check?.ok) return presign.fileUrl
    await sleep(1500)
  }
  throw new Error('La imagen subida no quedó accesible a tiempo.')
}

/**
 * Guion del video: el LLM convierte la idea del usuario en frases para
 * narración en voz alta (mismo idioma del usuario) y un prompt de imagen en
 * inglés por frase (las imágenes IA responden mejor en inglés). Si el LLM
 * falla, se degrada con honestidad a una escena única con la idea original.
 */
async function buildScript(
  zai: Awaited<ReturnType<typeof import('z-ai-web-dev-sdk').default.create>>,
  prompt: string,
  scenes: number,
): Promise<{ lines: string[]; imagePrompts: string[] }> {
  const system = [
    `Eres guionista de videos verticales cortos narrados con voz de IA.`,
    `A partir de la idea del usuario, escribe exactamente ${scenes} frases para narración en voz alta, en el MISMO idioma en el que escribió el usuario.`,
    `Cada frase: máximo 130 caracteres, tono cercano, visual y dinámico, sin emojis ni comillas.`,
    `Para cada frase crea además un prompt de imagen en INGLÉS: estilo cinematográfico fotográfico, formato vertical 9:16, sin texto ni letras en la imagen.`,
    `Responde ÚNICAMENTE con JSON válido (sin markdown ni explicaciones):`,
    `{"lines":["frase 1","frase 2"],"imagePrompts":["image prompt 1","image prompt 2"]}`,
  ].join(' ')
  try {
    const completion = (await zai.chat.completions.create({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
    })) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = completion?.choices?.[0]?.message?.content ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { lines?: unknown; imagePrompts?: unknown }
      const lines = Array.isArray(parsed.lines)
        ? parsed.lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).map((l) => l.trim().slice(0, 160))
        : []
      const imagePrompts = Array.isArray(parsed.imagePrompts)
        ? parsed.imagePrompts
            .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            .map((p) => p.trim().slice(0, 400))
        : []
      if (lines.length && imagePrompts.length) {
        return { lines: lines.slice(0, scenes), imagePrompts: imagePrompts.slice(0, scenes) }
      }
    }
  } catch {
    // Degradación controlada: guion mínimo con la idea original.
  }
  return {
    lines: [prompt.slice(0, 150)],
    imagePrompts: [`${prompt}, cinematic photography, dramatic lighting, vertical 9:16 composition, high detail`],
  }
}

/** Flujo completo JSON2Video: guion → imágenes IA → subida → render → mp4. */
async function generateWithJson2Video(args: {
  apiKey: string
  prompt: string
  sceneCount: number
}): Promise<{ buffer: Buffer; scenes: number }> {
  const { apiKey, prompt, sceneCount } = args
  const { default: ZAI } = await import('z-ai-web-dev-sdk')
  const zai = await ZAI.create()

  // 1) Guion narrado (frases + prompts de imagen en inglés).
  const script = await buildScript(zai, prompt, sceneCount)
  const pairs = script.lines
    .map((line, i) => ({ line, imagePrompt: script.imagePrompts[i] ?? script.imagePrompts[0] }))
    .filter((p) => Boolean(p.imagePrompt))
  if (!pairs.length) throw new Error('El guion del video quedó vacío.')

  // 2) Imágenes IA en paralelo (vertical 9:16, acorde al video tipo story).
  const settled = await Promise.allSettled(
    pairs.map((p) => zai.images.generations.create({ prompt: p.imagePrompt, size: '768x1344' })),
  )
  const pngs: Buffer[] = []
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const base64 = (outcome.value as { data?: Array<{ base64?: string }> })?.data?.[0]?.base64
      if (base64) pngs.push(Buffer.from(base64, 'base64'))
    }
  }
  if (!pngs.length) throw new Error('No se pudo generar ninguna imagen de escena.')

  // 3) Subida a medios JSON2Video → URLs públicas.
  const imageUrls: string[] = []
  for (let i = 0; i < pngs.length; i++) {
    imageUrls.push(await uploadPngToJ2v(apiKey, pngs[i], i))
  }

  // 4) Crear la película con el template narrado. Las variables no usadas
  //    se envían vacías: las escenas con texto vacío se saltan solas.
  const scenes = Math.min(pairs.length, imageUrls.length)
  const variables: Record<string, string> = { voice: J2V_VOICE }
  for (let i = 0; i < 3; i++) {
    variables[`text_${i + 1}`] = i < scenes ? pairs[i].line : ''
    variables[`image_${i + 1}`] = i < scenes ? imageUrls[i] : ''
  }
  const created = (await j2vRequest(apiKey, '/movies', {
    method: 'POST',
    body: JSON.stringify({ template: J2V_TEMPLATE, variables }),
  })) as { project?: unknown; success?: unknown }
  const projectId = typeof created.project === 'string' ? created.project : null
  if (!projectId) throw new Error('JSON2Video no aceptó la película (sin id de proyecto).')

  // 5) Sondeo del render: pending/running → done | error.
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS)
    const status = (await j2vRequest(apiKey, `/movies?id=${encodeURIComponent(projectId)}`)) as {
      movie?: { status?: string; url?: string | null; message?: string | null }
    }
    const movie = status.movie ?? {}
    if (movie.status === 'done' && typeof movie.url === 'string' && movie.url.startsWith('http')) {
      const videoRes = await fetch(movie.url, { cache: 'no-store' })
      if (!videoRes.ok) {
        throw new Error(`No se pudo descargar el vídeo renderizado (HTTP ${videoRes.status}).`)
      }
      const buffer = Buffer.from(await videoRes.arrayBuffer())
      if (!buffer.byteLength || buffer.byteLength > MAX_VIDEO_BYTES) {
        throw new Error('El vídeo renderizado no se pudo almacenar (vacío o demasiado grande).')
      }
      return { buffer, scenes }
    }
    const failed = typeof movie.status === 'string' && !['pending', 'running', 'done'].includes(movie.status)
    if (failed) {
      throw new Error(`El render falló en JSON2Video (estado ${movie.status}: ${movie.message ?? 'sin detalle'}).`)
    }
  }
  throw new Error('El render de JSON2Video tardó demasiado.')
}

/* ═══════════════════ Persistencia + respuesta compartidas ════════════════ */

async function persistAndRespond(args: {
  buffer: Buffer
  prompt: string
  sizeLabel: string
  sessionId?: string
  providerId: string
  modelId: string
  startedAt: number
  requestId: string
  guestSetCookie: string | null
}): Promise<Response> {
  const asset = await db.generatedAsset.create({
    data: {
      sessionId: args.sessionId ?? null,
      prompt: args.prompt,
      size: args.sizeLabel,
      mime: 'video/mp4',
      data: args.buffer,
    },
    select: { id: true },
  })

  // Mensaje del asistente en el historial (paridad con la imagen generada):
  // markdown de imagen con la pista `#video` que el renderer convierte en
  // <video controls> (contrato documentado en src/components/chat/markdown.tsx).
  if (args.sessionId) {
    try {
      await db.chatMessage.create({
        data: {
          sessionId: args.sessionId,
          role: 'assistant',
          content: `![Video generado](/api/assets/${asset.id}#video)`,
          assetId: asset.id,
          requestedModelId: 'tool:video',
          providerId: args.providerId,
          providerReportedModel: args.modelId,
          status: 'ok',
          latencyMs: Date.now() - args.startedAt,
        },
      })
    } catch (persistErr) {
      console.error('[api/tools/video] no se pudo persistir el resultado:', persistErr instanceof Error ? persistErr.message : persistErr)
    }
  }

  await recordUsage({
    requestId: args.requestId,
    source: 'tool_video',
    providerId: args.providerId,
    requestedModelId: args.modelId,
    resolvedModelId: args.modelId,
    status: 'ok',
    latencyMs: Date.now() - args.startedAt,
    promptChars: args.prompt.length,
  })

  return Response.json(
    {
      id: asset.id,
      url: `/api/assets/${asset.id}`,
      mimeType: 'video/mp4',
      latencyMs: Date.now() - args.startedAt,
      requestId: args.requestId,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        'X-Request-Id': args.requestId,
        ...(args.guestSetCookie ? { 'Set-Cookie': args.guestSetCookie } : {}),
      },
    },
  )
}

/* ══════════════════════════════ POST ═════════════════════════════════════ */

/**
 * POST /api/tools/video — generación de vídeo IA (solo servidor).
 * Proveedor principal: JSON2Video (template narrado: escenas con imagen IA +
 * voz IA multilingüe + subtítulos quemados). Si JSON2Video falla temprano, se
 * respalda con el vídeo generativo z-ai. En ambos casos el mp4 se persiste
 * como activo servible por /api/assets/[id] y consume un turno de la cuota de
 * invitado (misma compuerta que la generación de imágenes).
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  // Límite propio: generar vídeo es la herramienta más cara del sistema.
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'tools-video'), 3, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de generaciones de vídeo alcanzado. Espera un momento e inténtalo de nuevo.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  let body: z.infer<typeof VideoBodySchema>
  try {
    body = VideoBodySchema.parse(await request.json())
  } catch {
    return Response.json(
      {
        error:
          'Payload inválido: prompt (1-800 caracteres), size (1024x1024…1920x1080), duration (5 o 10) y withAudio (booleano).',
        requestId,
      },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  const prompt = body.prompt.trim()

  // Identidad + cuota: generar vídeo es un turno de chat para invitados
  // (misma compuerta que la generación de imágenes).
  let guestSetCookie: string | null = null
  try {
    const identity = await resolveChatIdentity(request)
    if (identity.kind === 'guest') {
      const quota = await consumeGuestChat(identity.guestId)
      if (!quota.allowed) {
        return Response.json(
          {
            error: `Has usado tus ${quota.limit} usos gratis de esta sesión. Inicia sesión con Google o GitHub para seguir generando vídeos y conversando sin límite.`,
            errorType: 'guest_limit_reached',
            used: quota.used,
            limit: quota.limit,
            requestId,
          },
          {
            status: 403,
            headers: {
              'X-Request-Id': requestId,
              ...(identity.isNewGuest ? { 'Set-Cookie': guestCookieHeader(identity.guestId) } : {}),
            },
          },
        )
      }
      if (identity.isNewGuest) guestSetCookie = guestCookieHeader(identity.guestId)
    }
  } catch (quotaErr) {
    console.error('[api/tools/video] cuota de invitado no disponible:', quotaErr instanceof Error ? quotaErr.message : quotaErr)
  }

  const startedAt = Date.now()
  try {
    // Persistencia del turno (paridad con /api/tools/image): la conversación y
    // el mensaje del usuario se guardan ANTES de generar; el resultado se añade
    // al terminar. Un fallo de persistencia no impide generar el vídeo.
    if (body.sessionId) {
      try {
        await db.chatSession.upsert({
          where: { id: body.sessionId },
          create: { id: body.sessionId, title: `Video: ${prompt.slice(0, 52)}` },
          update: { updatedAt: new Date() },
        })
        await db.chatMessage.create({
          data: { sessionId: body.sessionId, role: 'user', content: `Generar video: ${prompt}`, requestedModelId: 'tool:video', status: 'ok' },
        })
      } catch (persistErr) {
        console.error('[api/tools/video] no se pudo persistir el turno:', persistErr instanceof Error ? persistErr.message : persistErr)
      }
    }

    /* ── Proveedor principal: JSON2Video ─────────────────────────────────── */
    const j2vKey = process.env.JSON2VIDEO_API_KEY?.trim()
    if (j2vKey) {
      try {
        const result = await generateWithJson2Video({
          apiKey: j2vKey,
          prompt,
          sceneCount: body.duration === 10 ? 3 : 2,
        })
        return await persistAndRespond({
          buffer: result.buffer,
          prompt,
          sizeLabel: `9:16 narrado · ${result.scenes} escena${result.scenes === 1 ? '' : 's'} · JSON2Video`,
          sessionId: body.sessionId,
          providerId: 'json2video',
          modelId: `json2video:narrated-short:${J2V_TEMPLATE}`,
          startedAt,
          requestId,
          guestSetCookie,
        })
      } catch (j2vErr) {
        if (request.signal.aborted) {
          return Response.json(
            { error: 'Generación de vídeo cancelada.', requestId },
            { status: 499, headers: { 'X-Request-Id': requestId } },
          )
        }
        const j2vMessage = j2vErr instanceof Error ? j2vErr.message : 'error desconocido'
        console.error('[api/tools/video] JSON2Video falló:', j2vMessage.slice(0, 240))
        const elapsed = Date.now() - startedAt
        if (elapsed > FALLBACK_BUDGET_MS) {
          // Ya no queda tiempo útil para un segundo render: error honesto.
          await recordUsage({
            requestId,
            source: 'tool_video',
            providerId: 'json2video',
            requestedModelId: `json2video:narrated-short:${J2V_TEMPLATE}`,
            status: 'error',
            errorType: 'video_generation_failed',
            latencyMs: elapsed,
          })
          return Response.json(
            { error: `El video narrado no se pudo completar: ${j2vMessage}`, requestId },
            { status: 502, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
          )
        }
        // Fallo temprano → se continúa con el respaldo z-ai.
      }
    }

    /* ── Respaldo: vídeo generativo z-ai ────────────────────────────────── */
    const fallbackStartedAt = Date.now()
    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()

    // 1) Crear la tarea asíncrona de generación.
    const task = (await zai.video.generations.create({
      prompt,
      quality: 'speed',
      size: body.size,
      duration: body.duration,
      fps: 30,
      with_audio: body.withAudio,
    })) as { id?: string; task_status?: VideoTaskStatus }

    if (!task?.id) {
      throw new Error('El proveedor de vídeo no aceptó la tarea.')
    }

    // 2) Sondeo del resultado: PROCESSING → SUCCESS | FAIL (máx. 70 intentos).
    let videoUrl: string | null = null
    let status: VideoTaskStatus = task.task_status ?? 'PROCESSING'
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS)
      if (request.signal.aborted) {
        return Response.json(
          { error: 'Generación de vídeo cancelada.', requestId },
          { status: 499, headers: { 'X-Request-Id': requestId } },
        )
      }
      const result = (await zai.async.result.query(task.id)) as Record<string, unknown>
      status = (result.task_status as VideoTaskStatus) ?? 'PROCESSING'
      if (status === 'SUCCESS') {
        videoUrl = extractVideoUrl(result)
        break
      }
      if (status === 'FAIL') break
    }

    if (status !== 'SUCCESS' || !videoUrl) {
      const timedOut = status !== 'FAIL'
      await recordUsage({
        requestId,
        source: 'tool_video',
        providerId: 'zai-org',
        requestedModelId: 'video-generation',
        status: 'error',
        errorType: timedOut ? 'video_generation_timeout' : 'video_generation_failed',
        latencyMs: Date.now() - fallbackStartedAt,
      })
      return Response.json(
        {
          error: timedOut
            ? 'El video tardó demasiado (inténtalo con duration 5).'
            : 'El proveedor no pudo generar el video. Prueba con otro prompt o una duración menor.',
          requestId,
        },
        { status: timedOut ? 504 : 502, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
      )
    }

    // 3) Descargar el mp4 y persistirlo como activo servible.
    const videoRes = await fetch(videoUrl, { cache: 'no-store' })
    if (!videoRes.ok) {
      throw new Error(`No se pudo descargar el vídeo generado (HTTP ${videoRes.status}).`)
    }
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer())
    if (!videoBuffer.byteLength || videoBuffer.byteLength > MAX_VIDEO_BYTES) {
      throw new Error('El vídeo generado no se pudo almacenar (vacío o demasiado grande).')
    }

    return await persistAndRespond({
      buffer: videoBuffer,
      prompt,
      sizeLabel: `${body.size} · ${body.duration}s`,
      sessionId: body.sessionId,
      providerId: 'zai-org',
      modelId: 'video-generation',
      startedAt: fallbackStartedAt,
      requestId,
      guestSetCookie,
    })
  } catch (err) {
    if (request.signal.aborted) {
      return Response.json(
        { error: 'Generación de vídeo cancelada.', requestId },
        { status: 499, headers: { 'X-Request-Id': requestId } },
      )
    }
    console.error('[api/tools/video] error:', err instanceof Error ? err.message.slice(0, 200) : err)
    await recordUsage({
      requestId,
      source: 'tool_video',
      providerId: 'zai-org',
      requestedModelId: 'video-generation',
      status: 'error',
      errorType: 'video_generation_error',
      latencyMs: Date.now() - startedAt,
    })
    const message = err instanceof Error ? err.message : 'No se pudo generar el vídeo.'
    return Response.json(
      { error: message, requestId },
      { status: 502, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } },
    )
  }
}
