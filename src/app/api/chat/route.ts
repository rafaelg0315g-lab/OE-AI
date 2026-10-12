import { z } from 'zod'
import { db } from '@/lib/db'
import { resolveRoute, parseSelection, RouterError, type ModelSelection } from '@/lib/ai/router'
import { providerRegistry } from '@/lib/ai/providers'
import { recordUsage, countRequestsSince } from '@/lib/ai/usage'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { ROUTER_CONFIG } from '@/lib/ai/config'
import { latestChecks } from '@/lib/ai/health'
import { ProviderError, type ChatRequestMessage, type NormalizedCompletion, type ProductCategory, type RoutableRoute } from '@/lib/ai/types'
import { buildSearchContext, searchWeb } from '@/lib/ai/tools/web-search'
import { CAPACITY_SYSTEM_BLOCK, shouldAttachCapacityDoc } from '@/lib/ai/capacity-doc'
import { BUILDER_SYSTEM_BLOCK, shouldAttachBuilderDirective } from '@/lib/ai/builder-directive'
import { consumeGuestChat, guestCookieHeader, resolveChatIdentity } from '@/lib/auth/guest'
import {
  GEMINI_DIRECT_ROUTE,
  createGeminiDirectMiniAdapter,
  geminiSearchWeb,
} from '@/lib/ai/gemini-direct'
import { detectGalleryIntent, detectMediaIntent } from '@/lib/ai/image-intent'
import { generateImageWithCascade } from '@/lib/ai/image-cascade'
import { generateSvgCode } from '@/lib/ai/svg-generator'

export const dynamic = 'force-dynamic'
// Los turnos de medios (imagen/SVG detectados en lenguaje natural) pueden tardar
// más que un turno de texto: el techo de Vercel Hobby es 300 s.
export const maxDuration = 300

const ChatBodySchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(ROUTER_CONFIG.maxMessageChars),
  model: z.string().max(200).optional(),
  allowFallback: z.boolean().optional().default(true),
  /** Modo de respuesta: 'instant' (directo) o 'reflective' (razonamiento paso a paso). */
  mode: z.enum(['instant', 'reflective']).optional().default('instant'),
  /** Búsqueda web real antes de responder (fuentes citadas en el meta del mensaje). */
  webSearch: z.boolean().optional().default(false),
  /** Turno por voz: respuestas SIEMPRE en español, breves y sin markdown (se leen en voz alta). */
  voice: z.boolean().optional().default(false),
  /** Imagen adjuntada por el usuario (visión): id de GeneratedAsset servido por /api/assets/[id]. */
  attachmentId: z
    .string()
    .regex(/^[a-z0-9_-]{10,40}$/i, 'Identificador de imagen adjunta inválido.')
    .optional(),
  /** Instrucciones personales del usuario (memoria editable desde la UI). */
  customInstructions: z.string().max(2000).optional().default(''),
  /** Modo intérprete: código del idioma destino ('' = desactivado). */
  translatorTarget: z.enum(['', 'en', 'fr', 'pt', 'it', 'de']).optional().default(''),
  /** Texto de un documento leído (enlace/PDF vía /api/tools/read-doc) para el turno actual.
   *  Se inyecta en el prompt de sistema y NO se persiste en el historial. */
  docContext: z.string().min(1).max(24_000).optional(),
  /** Título del documento leído (nombre del archivo o de la página). */
  docTitle: z.string().max(300).optional(),
  /** Contexto efímero del último proyecto construido en esta conversación
   *  (para que el asistente pueda emitir modificaciones con projectId). */
  buildContext: z
    .object({
      projectId: z.string().regex(/^[a-z0-9_-]{6,45}$/i),
      title: z.string().max(80),
      files: z.array(z.string().max(120)).max(12),
    })
    .optional(),
})

/** Heurística ligera de tarea (solo orienta la selección automática; no es una afirmación sobre el modelo). */
function inferTask(message: string): ProductCategory | undefined {
  const t = message.toLowerCase()
  // Código: el usuario pide escribir/generar código o menciona un lenguaje/stack.
  // Solo estas peticiones salen por OpenRouter (política de enrutado del chat).
  if (
    /(código|codigo|code|función|funcion|script|bug|debug|python|javascript|typescript|sql|html|css|react|next\.?js|node|programar|programa una|algoritmo|regex|bash|docker|api rest|java\b|c\+\+|c#|php|golang|rust\b|swift|kotlin|desarrolla (una|el|la) (página|pagina|app|componente|función|funcion)|componente react)/.test(
      t,
    )
  )
    return 'coding'
  if (/(traduce|traducción|traduccion|translate|en inglés|en español)/.test(t)) return 'multilingual'
  if (/(resume|resumen|summar)/.test(t)) return 'fast'
  if (/(por qué|explique|razona|paso a paso|analiza)/.test(t)) return 'reasoning'
  return undefined
}

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Nombres legibles de los idiomas del modo intérprete. */
const TRANSLATOR_LANGUAGE_NAMES: Record<string, string> = {
  en: 'inglés',
  fr: 'francés',
  pt: 'portugués',
  it: 'italiano',
  de: 'alemán',
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  // 1) Límite de peticiones por IP
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'chat'), ROUTER_CONFIG.chatRequestsPerMinute, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Has superado el límite de peticiones por minuto. Inténtalo de nuevo en unos segundos.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  // 2) Límite diario global de protección de costes
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const todayCount = await countRequestsSince(startOfDay)
  if (todayCount >= ROUTER_CONFIG.maxDailyRequests) {
    return Response.json(
      { error: 'Se alcanzó el límite diario de solicitudes configurado para este entorno.', requestId },
      { status: 429, headers: { 'X-Request-Id': requestId } },
    )
  }

  // 3) Validación de payload
  let body: z.infer<typeof ChatBodySchema>
  try {
    const raw = await request.json()
    body = ChatBodySchema.parse(raw)
  } catch {
    return Response.json(
      { error: `Payload inválido. Revisa sessionId (uuid), message (1-${ROUTER_CONFIG.maxMessageChars} caracteres).`, requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  const selection: ModelSelection = parseSelection(body.model)

  // Imagen adjuntada (visión): se valida ANTES de abrir el stream. El turno con
  // imagen lo procesa el núcleo z-ai (createVision); no hay respaldo OpenRouter
  // (su ruta de texto no procesa imágenes y fallaría de forma inútil).
  let attachment: { id: string; mime: string; dataUrl: string } | null = null
  if (body.attachmentId) {
    try {
      const asset = await db.generatedAsset.findUnique({
        where: { id: body.attachmentId },
        select: { id: true, mime: true, data: true },
      })
      if (!asset || !asset.mime.startsWith('image/')) {
        return Response.json(
          { error: 'La imagen adjunta no está disponible o expiró. Vuelve a adjuntarla.', requestId },
          { status: 400, headers: { 'X-Request-Id': requestId } },
        )
      }
      attachment = {
        id: asset.id,
        mime: asset.mime,
        dataUrl: `data:${asset.mime};base64,${Buffer.from(asset.data).toString('base64')}`,
      }
    } catch {
      return Response.json(
        { error: 'No se pudo cargar la imagen adjunta.', requestId },
        { status: 500, headers: { 'X-Request-Id': requestId } },
      )
    }
  }

  const task = attachment ? undefined : inferTask(body.message)

  // 4) Resolución de ruta ANTES de abrir el stream (errores = JSON, no SSE)
  // Rutas con comprobación real 'ok' registrada: el modo Automático las prioriza.
  let decision
  try {
    if (attachment) {
      // Ruta fija con visión: núcleo OE AI LLM (z-ai) — el único con visión verificada.
      const visionRoute = providerRegistry
        .availableRoutes()
        .find((r) => r.providerId === 'zai-org' && r.catalogModelId === null)
      if (!visionRoute) {
        return Response.json(
          { error: 'El núcleo con visión no está disponible ahora mismo.', requestId },
          { status: 503, headers: { 'X-Request-Id': requestId } },
        )
      }
      decision = {
        route: visionRoute,
        fallbackUsed: false,
        note: 'Imagen adjunta: la analiza el núcleo OE AI LLM con visión.',
      }
    } else {
      let verifiedRouteKeys: Set<string> | undefined
      if (selection.kind === 'auto') {
        try {
          const checks = await latestChecks()
          verifiedRouteKeys = new Set(
            providerRegistry
              .availableRoutes()
              .filter((r) => r.catalogModelId && checks.get(`model:${r.catalogModelId}`)?.status === 'ok')
              .map((r) => r.key),
          )
          if (verifiedRouteKeys.size === 0) verifiedRouteKeys = undefined
        } catch {
          verifiedRouteKeys = undefined
        }
      }
      decision = resolveRoute(selection, task, body.allowFallback, verifiedRouteKeys, task === 'coding' ? 'verified' : 'core')
    }
  } catch (err) {
    const isRouterErr = err instanceof RouterError
    const message = isRouterErr
      ? err.message
      : 'No se pudo resolver la ruta del modelo.'
    const errorType = isRouterErr ? err.errorType : 'route_error'
    await recordUsage({ requestId, source: 'chat', status: 'error', errorType, requestedModelId: body.model ?? 'auto', task })
    return Response.json(
      { error: message, errorType, requestId },
      { status: isRouterErr && (err.errorType === 'unknown_model' || err.errorType === 'route_not_configured') ? 400 : 503, headers: { 'X-Request-Id': requestId } },
    )
  }

  const adapter = providerRegistry.get(decision.route.providerId)
  if (!adapter) {
    await recordUsage({ requestId, source: 'chat', status: 'error', errorType: 'adapter_missing', task })
    return Response.json({ error: 'Adaptador de proveedor no disponible.', requestId }, { status: 503, headers: { 'X-Request-Id': requestId } })
  }

  // 4b) Identidad + cuota: invitados con N chats gratis por sesión de navegador;
  // usuarios verificados (token Supabase) chatean sin límite. Se comprueba
  // DESPUÉS de resolver la ruta: los errores de infraestructura propia no
  // queman chats del usuario. Si falla el modelo en ejecución, el intento sí cuenta.
  let guestSetCookie: string | null = null
  // ownerKey de la memoria personalizada (supabaseId o id de invitado).
  let identityOwnerKey: string | null = null
  // Identidad resuelta para el paso 5 (pertenencia del chat).
  let identity: Awaited<ReturnType<typeof resolveChatIdentity>> | null = null
  // true cuando la sesión existía sin dueño y pasa al usuario verificado actual.
  let adoptOwnerlessSession = false
  try {
    identity = await resolveChatIdentity(request)
    identityOwnerKey = identity.kind === 'user' ? identity.supabaseId : identity.guestId

    // PRIVACIDAD (aplica a TODAS las identidades, usuarios e invitados): cada
    // chat pertenece a la cuenta que lo creó. Si la sesión ya tiene dueño y el
    // llamador no es ese usuario verificado → 404 (sin quemar cuota). Una
    // sesión legado sin dueño se ADOPTA al primer usuario verificado que
    // escribe en ella (el uuid es aleatorio e intransferible: mismo modelo de
    // confianza que antes, ahora con dueño).
    const existingSession = await db.chatSession
      .findUnique({ where: { id: body.sessionId }, select: { ownerKey: true } })
      .catch(() => null)
    if (existingSession?.ownerKey) {
      // Sesión con dueño: SOLO su propietario verificado puede escribir en ella.
      const ownerMatches = identity.kind === 'user' && existingSession.ownerKey === identity.supabaseId
      if (!ownerMatches) {
        return Response.json(
          { error: 'Este chat es privado o no existe.', requestId },
          { status: 404, headers: { 'X-Request-Id': requestId } },
        )
      }
    } else {
      adoptOwnerlessSession = identity.kind === 'user' && Boolean(existingSession)
    }

    if (identity.kind === 'guest') {
      const quota = await consumeGuestChat(identity.guestId)
      if (!quota.allowed) {
        return Response.json(
          {
            error: `Has usado tus ${quota.limit} chats gratis de esta sesión. Inicia sesión con Google o GitHub para continuar conversando sin límite.`,
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
    console.error('[api/chat] cuota de invitado no disponible:', quotaErr instanceof Error ? quotaErr.message : quotaErr)
    // Fallo de infraestructura propia: se permite el turno (no se castiga al usuario).
  }

  // 4b-bis) TURNO DE MEDIOS: el usuario pidió una imagen/icono/SVG en lenguaje
  // natural ("crea una imagen de…", "genera un icono SVG de…"). La intención se
  // detecta sin botones; el turno lo ejecuta la herramienta de medios del núcleo
  // (la cuota de invitado ya se consumió arriba: 1 turno = 1 uso) y responde por
  // SSE con eventos dedicados. No aplica si hay adjunto de visión, modo voz,
  // intérprete, contexto de constructor o documento leído (esos turnos son chat).
  // PRIORIDAD: si pide VER imágenes de la web ("busca/muéstrame imágenes de…")
  // es una GALERÍA (búsqueda real), no generación: el turno sigue siendo chat
  // con una directiva que obliga a emitir el bloque :::gallery.
  const galleryTurn =
    !attachment && !body.voice && body.translatorTarget === '' && !body.buildContext && !body.docContext
      ? detectGalleryIntent(body.message)
      : null
  const mediaIntent = galleryTurn
    ? null
    : !attachment && !body.voice && body.translatorTarget === '' && !body.buildContext && !body.docContext
      ? detectMediaIntent(body.message)
      : null

  if (mediaIntent) {
    const isSvg = mediaIntent.format === 'svg'
    const toolName = isSvg ? 'tool:svg' : 'tool:image'
    await db.chatSession.upsert({
      where: { id: body.sessionId },
      create: {
        id: body.sessionId,
        title: body.message.slice(0, 60),
        ...(identity?.kind === 'user' ? { ownerKey: identity.supabaseId } : {}),
      },
      update: {
        updatedAt: new Date(),
        ...(identity?.kind === 'user' && adoptOwnerlessSession ? { ownerKey: identity.supabaseId } : {}),
      },
    })
    await db.chatMessage.create({
      data: { sessionId: body.sessionId, role: 'user', content: body.message, requestedModelId: toolName, status: 'ok' },
    })

    const encoder = new TextEncoder()
    const startedAt = Date.now()
    const mediaStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(sseChunk(event, data)))
          } catch {
            // cliente desconectado
          }
        }

        send('meta', {
          requestId,
          providerId: isSvg ? 'tool-svg' : 'tool-image',
          providerLabel: isSvg ? 'OE Media · Diseño SVG' : 'OE Media · Imagen',
          routeKey: toolName,
          catalogModelId: null,
          routeLabel: isSvg ? 'Diseño vectorial SVG' : 'Generación de imagen',
          routeNote: isSvg
            ? 'Pediste SVG: se diseña código vectorial real que puedes descargar y escalar sin límite.'
            : mediaIntent.format === 'icon'
              ? 'Detecté un icono: lo genero como PNG con estilo de icono (es lo ideal para iconos).'
              : 'Detecté una petición de imagen: la genero con el núcleo de medios.',
          fallbackUsed: false,
          streaming: false,
          sessionId: body.sessionId,
          sessionTitle: body.message.slice(0, 60),
          mode: body.mode,
          webSearch: false,
          vision: false,
          // Contrato del turno de medios: el cliente transforma el marcador en
          // tarjeta de imagen (image) o deja fluir el texto (svg).
          turn: isSvg ? 'svg' : 'image',
          mediaFormat: mediaIntent.format,
          coreLabel: 'OE Media',
        })

        try {
          if (isSvg) {
            send('stage', { stage: 'svg_design' })
            const svg = await generateSvgCode(mediaIntent.prompt)
            const content = `:::svg\n${svg.code}\n:::`
            const assistant = await db.chatMessage.create({
              data: {
                sessionId: body.sessionId,
                role: 'assistant',
                content,
                requestedModelId: toolName,
                resolvedModelId: 'tool:svg',
                providerId: svg.providerId,
                providerReportedModel: svg.providerReportedModel,
                status: 'ok',
                latencyMs: svg.latencyMs,
              },
            })
            await recordUsage({
              requestId,
              source: 'tool_svg',
              providerId: svg.providerId,
              requestedModelId: 'tool:svg',
              resolvedModelId: svg.providerReportedModel ?? 'svg',
              status: 'ok',
              latencyMs: svg.latencyMs,
              promptChars: mediaIntent.prompt.length,
              completionChars: svg.code.length,
            })
            send('delta', { text: content })
            send('done', {
              messageId: assistant.id,
              latencyMs: svg.latencyMs,
              providerReportedModel: svg.providerReportedModel,
              providerId: svg.providerId,
              fallbackUsed: false,
              webSearchUsed: false,
              visionUsed: false,
              docRead: false,
            })
          } else {
            send('stage', { stage: 'image' })
            const outcome = await generateImageWithCascade({ prompt: mediaIntent.prompt, size: mediaIntent.size })
            const asset = await db.generatedAsset.create({
              data: {
                sessionId: body.sessionId,
                prompt: mediaIntent.subject,
                size: mediaIntent.size,
                mime: outcome.mime,
                data: outcome.buffer,
              },
            })
            const latencyMs = Date.now() - startedAt
            const message = await db.chatMessage.create({
              data: {
                sessionId: body.sessionId,
                role: 'assistant',
                content: mediaIntent.subject,
                kind: 'image',
                assetId: asset.id,
                requestedModelId: toolName,
                resolvedModelId: 'tool:image',
                providerId: outcome.providerId,
                providerReportedModel: outcome.reportedModel,
                status: 'ok',
                latencyMs,
              },
            })
            await recordUsage({
              requestId,
              source: 'tool_image',
              providerId: outcome.providerId,
              requestedModelId: 'image-generation',
              resolvedModelId: outcome.reportedModel,
              status: 'ok',
              latencyMs,
              promptChars: mediaIntent.prompt.length,
            })
            send('image', {
              url: `/api/assets/${asset.id}`,
              assetId: asset.id,
              prompt: mediaIntent.subject,
              size: mediaIntent.size,
              format: mediaIntent.format,
              latencyMs,
            })
            send('done', {
              messageId: message.id,
              latencyMs,
              providerReportedModel: outcome.reportedModel,
              providerId: outcome.providerId,
              fallbackUsed: false,
              webSearchUsed: false,
              visionUsed: false,
              docRead: false,
            })
          }
        } catch (err) {
          console.error('[api/chat] error en turno de medios:', err instanceof Error ? err.message : err)
          await recordUsage({
            requestId,
            source: isSvg ? 'tool_svg' : 'tool_image',
            providerId: 'cascade',
            requestedModelId: toolName,
            status: 'error',
            errorType: isSvg ? 'svg_generation_error' : 'image_generation_error',
            latencyMs: Date.now() - startedAt,
          })
          send('error', {
            message: isSvg
              ? 'No pude diseñar el SVG en este momento. Inténtalo de nuevo o pídemelo como imagen PNG.'
              : 'No pude generar la imagen: los proveedores de imagen no respondieron. Inténtalo de nuevo en unos segundos.',
            errorType: isSvg ? 'svg_generation_error' : 'image_generation_error',
            requestId,
          })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(mediaStream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': requestId,
        ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}),
      },
    })
  }

  // 4c) Memoria personalizada: los 12 datos más recientes del ownerKey se
  // inyectan como prefijo del prompt de sistema (fallo = continuar sin memoria).
  let memoryFacts: string[] = []
  if (identityOwnerKey) {
    try {
      const memoryRows = await db.chatMemory.findMany({
        where: { ownerKey: identityOwnerKey },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { fact: true },
      })
      memoryFacts = memoryRows.map((r) => r.fact)
    } catch (memErr) {
      console.error('[api/chat] memoria no disponible:', memErr instanceof Error ? memErr.message : memErr)
    }
  }

  // Respaldo EN EJECUCIÓN (política del producto): si el núcleo OE AI LLM (z-ai)
  // falla —incluido el caso de despliegues sin credenciales del SDK, p. ej. Vercel—
  // la cadena continúa: 1) Gemini directo (AI Studio; texto Y visión),
  // 2) OpenRouter (solo texto). Cada respaldo se informa con honestidad vía SSE.
  type RuntimeFallback = { id: string; label: string; adapter: NonNullable<ReturnType<typeof providerRegistry.get>>; route: RoutableRoute }
  const runtimeFallbacks: RuntimeFallback[] = []
  if (decision.route.providerId !== 'gemini-direct' && process.env.GEMINI_API_KEY?.trim()) {
    const geminiAdapter = createGeminiDirectMiniAdapter() as unknown as RuntimeFallback['adapter']
    runtimeFallbacks.push({ id: 'gemini-direct', label: 'Gemini (respaldo directo)', adapter: geminiAdapter, route: GEMINI_DIRECT_ROUTE })
  }
  if (!attachment && decision.route.providerId !== 'openrouter' && process.env.OPENROUTER_API_KEY) {
    const orRoutes = providerRegistry.availableRoutes().filter((r) => r.providerId === 'openrouter')
    if (orRoutes.length > 0) {
      let openRouterFallbackRoute: RoutableRoute | null
      try {
        const checks = await latestChecks()
        openRouterFallbackRoute =
          orRoutes.find((r) => r.catalogModelId && checks.get(`model:${r.catalogModelId}`)?.status === 'ok') ?? null
      } catch {
        openRouterFallbackRoute = null
      }
      openRouterFallbackRoute ??= orRoutes[0]
      if (openRouterFallbackRoute) {
        const orAdapter = providerRegistry.get(openRouterFallbackRoute.providerId)
        if (orAdapter) {
          runtimeFallbacks.push({ id: 'openrouter', label: 'OpenRouter', adapter: orAdapter, route: openRouterFallbackRoute })
        }
      }
    }
  }

  // 5) Sesión + historial. Los chats de usuarios verificados son PRIVADOS:
  // ownerKey = supabaseId fijado en SERVIDOR (nunca por el cliente). Invitados:
  // sesión sin dueño (efímera para la interfaz: sin historial visible).
  const session = await db.chatSession.upsert({
    where: { id: body.sessionId },
    create: {
      id: body.sessionId,
      title: body.message.slice(0, 60),
      ...(identity?.kind === 'user' ? { ownerKey: identity.supabaseId } : {}),
    },
    update: {
      updatedAt: new Date(),
      ...(identity?.kind === 'user' && adoptOwnerlessSession ? { ownerKey: identity.supabaseId } : {}),
    },
  })
  const historyRows = await db.chatMessage.findMany({
    where: { sessionId: body.sessionId, status: 'ok' },
    orderBy: { createdAt: 'asc' },
    take: ROUTER_CONFIG.maxHistoryMessages,
  })
  // Mensaje del usuario actual: multimodal (texto + imagen) si hay adjunto.
  // Nota: los turnos anteriores se reenvían como texto (la imagen solo se
  // analiza en el turno en que se adjunta; así el contexto no crece sin límite).
  const userContent: ChatRequestMessage['content'] = attachment
    ? [
        { type: 'text' as const, text: body.message },
        { type: 'image_url' as const, image_url: { url: attachment.dataUrl } },
      ]
    : body.message
  // Prompt de sistema: el modo intérprete (translatorTarget) REEMPLAZA todo
  // el prompt (prioridad sobre el modo voz); en el resto se combinan memoria
  // personalizada (prefijo), instrucciones personales y el modo voz.
  // Regla de idioma común: los modelos de respaldo (OpenRouter :free) tienden a
  // contestar en inglés o a sobre-analizar errores de tipeo; la directiva fija el
  // idioma del usuario y la interpretación natural de lo que escribe.
  const LANGUAGE_RULE =
    ' Responde SIEMPRE en el idioma en el que escribe el usuario (por defecto, español). Si escribe con errores de tipeo o abreviaturas (p. ej. "hoa"), interpreta la intención obvia y responde con naturalidad, sin pedir aclaraciones innecesarias ni analizar el error.'
  // Formato rico (interfaz estilo GPT): planes con timeline, tarjetas con
  // icono y galerías con imágenes reales de la web traídas al chat.
  const RICH_FORMAT_RULE =
    '\n\nFORMATO RICO: tienes tres bloques especiales para respuestas interactivas (sintaxis EXACTA, sin markdown dentro):\n' +
    '1) PLAN por fases (cuando pidan un plan, roadmap, estrategia o pasos ordenados):\n:::plan\n- Título del paso | Explicación de una o dos frases.\n- Siguiente paso | Su explicación.\n:::\n' +
    '2) TARJETAS con icono (secciones paralelas: categorías, auditorías, comparativas, características):\n:::cards\n- zap | Título corto | Descripción de una o dos frases.\n- mic | Otro título | Otra descripción.\n:::\n' +
    'El icono (antes del primer |) debe ser UNA de estas palabras: zap, mic, eye, shield, database, cpu, globe, image, code, rocket, settings, users, lock, brain, sparkles, wrench, cloud, phone, mail, clock, check, book, search, bot, palette, video, music, folder, key, server, layers, box, star, heart, flag, compass, camera, terminal, bug, package, credit-card, trending-up, target, award, briefcase, building, home, leaf, sun, moon, flame, link, map, gift, wifi, activity, dollar, message, play, file, calendar, cart, truck, headphones, gamepad, plane, car, graduation, pulse, scale, lightbulb.\n' +
    '3) GALERÍA con imágenes reales de la web (cuando el tema tenga elementos VISUALES: lugares, animales, arte, arquitectura, deportes, comida, personas famosas, productos, diseño, moda, vehículos, naturaleza, tecnología visual…, o cuando te pidan imágenes/ejemplos visuales):\n:::gallery\n- Título | Descripción de una frase. | consulta de busqueda en ingles\n- Otro título | Otra descripción. | otra consulta ingles\n:::\nLa consulta (tercer campo) va EN INGLÉS, 2-5 palabras, muy descriptiva y fotográfica (p. ej. "modern skyscraper night lights"). Usa 2-4 filas por galería.\n' +
    'Reglas: máximo DOS bloques por respuesta y solo si aportan valor; el resto del texto en markdown normal (párrafos, listas, negritas). No uses bloques si la respuesta es corta o conversacional. NUNCA inventes URL de imágenes: las imágenes las busca la plataforma a partir de la consulta.'
  // Estilo de respuesta: desarrollada, cálida y con energía (nada de respuestas
  // de una línea cuando el tema lo amerita), como un asistente premium.
  const STYLE_RULE =
    '\n\nESTILO DE RESPUESTA: desarrolla tus respuestas con sustancia: contexto, ejemplos concretos, matices y un cierre útil (una sugerencia de siguiente paso o una pregunta que invite a seguir). Para preguntas abiertas escribe varias secciones o párrafos bien organizados; evita contestar en una sola línea salvo saludos o preguntas de sí/no. Tono cálido, cercano y con energía positiva, como un experto amigo: alguna interjección natural está bien. Usa emojis con moderación (máximo 1-2 por respuesta) y nunca repitas la misma estructura mecánicamente.'
  const baseSystem =
    (body.mode === 'reflective'
      ? 'Eres OE AI LLM, el modelo unificado de OE BUSINESS. Responde con razonamiento paso a paso, cuidadoso y bien estructurado, usando markdown cuando ayude a la claridad.'
      : 'Eres OE AI LLM, el modelo unificado de OE BUSINESS. Responde de forma directa, clara y útil, usando markdown cuando ayude a la claridad.') +
    LANGUAGE_RULE +
    RICH_FORMAT_RULE +
    STYLE_RULE
  const systemMessages: ChatRequestMessage[] = []
  if (body.translatorTarget) {
    const langName = TRANSLATOR_LANGUAGE_NAMES[body.translatorTarget]
    systemMessages.push({
      role: 'system' as const,
      content: `Eres un intérprete de conversación hablada. Traduce TODO lo que diga el usuario a ${langName} y responde SOLO con la traducción, en tono natural hablado, sin explicaciones, sin comillas, sin markdown. Si el usuario escribe en el idioma destino, tradúcelo al español.`,
    })
  } else {
    let systemContent = baseSystem
    if (memoryFacts.length > 0) {
      systemContent = `Datos que recuerdas del usuario (úsolos con naturalidad si son relevantes):\n${memoryFacts
        .map((f) => `- ${f}`)
        .join('\n')}\n\n${systemContent}`
    }
    const personalInstructions = body.customInstructions.trim()
    if (personalInstructions) {
      systemContent = `${systemContent}\n\nInstrucciones personales del usuario: ${personalInstructions}`
    }
    // Documento leído para este turno (enlace web o PDF): contexto efímero,
    // nunca se guarda en el historial (el mensaje persistido es solo el texto).
    if (body.docContext) {
      const docTitle = (body.docTitle ?? '').trim() || 'documento'
      systemContent = `${systemContent}\n\nDocumento adjunto por el usuario (${docTitle}):\n${body.docContext}\n\nResponde a partir de este documento si el usuario pregunta sobre él.`
    }
    // Ficha técnica oficial (parámetros/capacidad/escala de la red): se adjunta
    // solo cuando la consulta trata sobre el tamaño o la arquitectura de OE AI.
    if (shouldAttachCapacityDoc(body.message)) {
      systemContent = `${systemContent}\n\n${CAPACITY_SYSTEM_BLOCK}`
    }
    // Turno de GALERÍA: el usuario pidió ver imágenes reales del tema X. Se
    // obliga a emitir el bloque :::gallery (la plataforma busca las fotos).
    if (galleryTurn) {
      systemContent = `${systemContent}\n\nGALERÍA DE LA WEB OBLIGATORIA: el usuario pidió ver imágenes reales sobre "${galleryTurn.subject}". Tu respuesta DEBE incluir exactamente UN bloque :::gallery con 3-4 filas en este formato EXACTO:\n- Título breve | Frase que explica qué muestra la imagen y por qué importa. | consulta de busqueda en ingles\nLas consultas (tercer campo) van EN INGLÉS, 3-5 palabras, descriptivas y fotográficas, y cada una cubre un ángulo distinto del tema. Añade además un párrafo de introducción y comentarios en markdown sobre lo que se ve; las imágenes NO las inventas tú: las busca la plataforma.`
    }
    // Constructor de apps: la directiva ```oe-build se emite solo cuando el
    // usuario pide construir/crear una app completa (no para dudas de código,
    // y nunca en modo voz: la respuesta se lee en alta voz).
    if (!body.voice && shouldAttachBuilderDirective(body.message)) {
      const bc = body.buildContext as { projectId?: string; title?: string; files?: string[]; kind?: string } | undefined
      const projectNote = bc?.projectId
        ? `\nProyecto construido recientemente en esta conversación: id="${bc.projectId}" ("${bc.title ?? ''}"), tipo: ${bc.kind === 'web' ? 'sitio web (Web Factory)' : 'app (Constructor)'}, archivos: ${(bc.files ?? []).join(', ')}. Si la petición del usuario es un cambio, ajuste o mejora de ESE proyecto (estilo, colores, secciones, hero, textos), es OBLIGATORIO tratarla como MODIFICACIÓN: emite la directiva del mismo tipo (${bc.kind === 'web' ? 'oe-web' : 'oe-build'}) incluyendo "projectId":"${bc.projectId}", sin escribir código inline. Si pide algo totalmente nuevo, omite projectId.`
        : ''
      systemContent = `${systemContent}\n\n${BUILDER_SYSTEM_BLOCK}${projectNote}`
    }
    systemMessages.push({ role: 'system' as const, content: systemContent })
    // Modo voz (Voz ➡️ Texto ➡️ IA ➡️ Voz): español garantizado y estilo hablado.
    if (body.voice) {
      systemMessages.push({
        role: 'system' as const,
        content:
          'Estás en una conversación por VOZ en tiempo real. Responde SIEMPRE en español, con un tono natural, cálido y conversacional. Sé breve: como máximo dos o tres frases cortas por respuesta. PROHIBIDO usar markdown, listas, emojis, enlaces, negritas ni bloques de código (tampoco bloques :::cards ni :::svg): tu texto se convierte directamente en voz sintética y debe sonar bien leído en voz alta.',
      })
    }
  }

  const messages: ChatRequestMessage[] = [
    ...systemMessages,
    ...historyRows.map((m) => ({ role: m.role as ChatRequestMessage['role'], content: m.content })),
    { role: 'user' as const, content: userContent },
  ]

  await db.chatMessage.create({
    data: {
      sessionId: body.sessionId,
      role: 'user',
      content: body.message,
      requestedModelId: body.model ?? 'auto',
      attachmentAssetId: attachment?.id ?? null,
      status: 'ok',
    },
  })

  // 6) Stream SSE: meta → delta (respuesta completa, sin streaming de tokens no verificado) → done | error
  const encoder = new TextEncoder()
  const abortController = new AbortController()
  request.signal.addEventListener('abort', () => abortController.abort())

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseChunk(event, data)))
        } catch {
          // cliente desconectado
        }
      }

      send('meta', {
        requestId,
        providerId: decision.route.providerId,
        providerLabel: adapter.label,
        routeKey: decision.route.key,
        catalogModelId: decision.route.catalogModelId,
        routeLabel: decision.route.label,
        routeNote: decision.note,
        fallbackUsed: decision.fallbackUsed,
        streaming: adapter.capabilities.streaming, // false: no se anuncia streaming no verificado
        sessionId: body.sessionId,
        sessionTitle: session.title,
        mode: body.mode,
        webSearch: body.webSearch,
        vision: Boolean(attachment),
        // Etiqueta amigable del núcleo activo para la interfaz premium.
        coreLabel: adapter.label.split(' (')[0],
      })

      try {
        // Búsqueda web real (opcional): fuentes normalizadas + contexto para el modelo.
        // Cadena: núcleo z-ai → Gemini grounding (google_search). Si ambas fallan,
        // se continúa SIN fuentes y se informa con honestidad.
        let searchSources: Awaited<ReturnType<typeof searchWeb>> = []
        if (body.webSearch) {
          send('stage', { stage: 'web_search' })
          try {
            const { default: ZAI } = await import('z-ai-web-dev-sdk')
            const zai = await ZAI.create()
            searchSources = await searchWeb(zai, body.message, 6)
          } catch {
            searchSources = []
          }
          if (searchSources.length === 0 && process.env.GEMINI_API_KEY?.trim()) {
            try {
              searchSources = await geminiSearchWeb(body.message, 6)
            } catch {
              searchSources = []
            }
          }
          if (!searchSources.length) {
            send('search_error', {
              message: 'La búsqueda web no estuvo disponible. Respondo sin fuentes web.',
            })
          }
          if (searchSources.length) send('search', { sources: searchSources })
        }

        const contextMessages: ChatRequestMessage[] = searchSources.length
          ? ([
              {
                role: 'system' as const,
                content: `Contexto de búsqueda web para la consulta actual:\n\n${buildSearchContext(searchSources)}`,
              },
            ] satisfies ChatRequestMessage[])
          : []

        // Ejecución del modelo: streaming SSE verificado (deltas incrementales)
        // o respuesta única normalizada. Nunca se simula éxito. Si el núcleo
        // z-ai falla antes de emitir contenido, OpenRouter respalda el turno.
        let emittedChars = 0
        const runWith = async (
          target: { capabilities: { streaming: boolean }; chatStream?: typeof adapter.chatStream; chat: typeof adapter.chat },
          route: RoutableRoute,
        ): Promise<NormalizedCompletion> => {
          if (target.capabilities.streaming && typeof target.chatStream === 'function') {
            const iter = target.chatStream({
              messages: [...messages, ...contextMessages],
              providerModelId: route.providerModelId,
              signal: abortController.signal,
            })
            let final: NormalizedCompletion | undefined
            while (true) {
              const { value, done } = await iter.next()
              if (done) {
                final = value
                break
              }
              emittedChars += value.delta.length
              send('delta', { text: value.delta })
            }
            if (!final) throw new ProviderError('El proveedor no devolvió contenido.', 'empty_response')
            return final
          }
          const single = await target.chat({
            messages: [...messages, ...contextMessages],
            providerModelId: route.providerModelId,
            signal: abortController.signal,
          })
          emittedChars += single.content.length
          send('delta', { text: single.content })
          return single
        }

        let completion: NormalizedCompletion
        let activeRoute = decision.route
        let runtimeFallbackUsed = false
        try {
          completion = await runWith(adapter, activeRoute)
        } catch (primaryErr) {
          if (abortController.signal.aborted) {
            controller.close()
            return
          }
          const abortedErr = primaryErr instanceof ProviderError && primaryErr.errorType === 'client_cancelled'
          const canFallback = !abortedErr && emittedChars === 0
          if (!canFallback || runtimeFallbacks.length === 0) throw primaryErr
          // Cadena de respaldo: Gemini directo → OpenRouter (solo si cambian de
          // proveedor). Cada salto se informa; si todos fallan, gana el error original.
          const reason = primaryErr instanceof Error ? primaryErr.message.slice(0, 140) : 'error del proveedor'
          let recovered = false
          let lastFallbackErr: unknown = primaryErr
          for (const fb of runtimeFallbacks) {
            if (fb.route.providerId === decision.route.providerId) continue
            send('route_fallback', {
              message: `El proveedor principal no pudo completar la solicitud; respaldado con ${fb.label}.`,
              detail: reason,
            })
            try {
              completion = await runWith(fb.adapter, fb.route)
              activeRoute = fb.route
              runtimeFallbackUsed = true
              recovered = true
              break
            } catch (fbErr) {
              if (abortController.signal.aborted) {
                controller.close()
                return
              }
              lastFallbackErr = fbErr
            }
          }
          if (!recovered) throw lastFallbackErr instanceof Error ? lastFallbackErr : primaryErr
        }

        const assistant = await db.chatMessage.create({
          data: {
            sessionId: body.sessionId,
            role: 'assistant',
            content: completion.content,
            requestedModelId: body.model ?? 'auto',
            resolvedModelId: activeRoute.catalogModelId ?? activeRoute.key,
            providerId: activeRoute.providerId,
            providerReportedModel: completion.providerReportedModel,
            status: 'ok',
            latencyMs: completion.latencyMs,
            fallbackUsed: decision.fallbackUsed || runtimeFallbackUsed,
            sourcesJson: searchSources.length ? JSON.stringify(searchSources) : null,
          },
        })

        await recordUsage({
          requestId,
          source: 'chat',
          providerId: activeRoute.providerId,
          requestedModelId: body.model ?? 'auto',
          resolvedModelId: activeRoute.catalogModelId ?? activeRoute.key,
          providerReportedModel: completion.providerReportedModel,
          task: task ?? null,
          status: 'ok',
          latencyMs: completion.latencyMs,
          promptChars: completion.promptChars,
          completionChars: completion.completionChars,
          fallbackUsed: decision.fallbackUsed || runtimeFallbackUsed,
        })

        send('done', {
          messageId: assistant.id,
          latencyMs: completion.latencyMs,
          providerReportedModel: completion.providerReportedModel,
          providerId: activeRoute.providerId,
          fallbackUsed: decision.fallbackUsed || runtimeFallbackUsed,
          webSearchUsed: body.webSearch && searchSources.length > 0,
          visionUsed: Boolean(attachment),
          docRead: Boolean(body.docContext),
        })
      } catch (err) {
        // Cancelación del usuario o cliente desconectado: se cierra sin error.
        if (abortController.signal.aborted) {
          controller.close()
          return
        }
        // Registro servidor sin contenido de prompts/respuestas (privacidad).
        console.error('[api/chat] stream error:', err instanceof Error ? err.message : err)
        const errorType = err instanceof ProviderError ? err.errorType : 'provider_error'
        const safeMessage =
          err instanceof ProviderError
            ? err.message
            : 'El proveedor no pudo completar la solicitud. No se generó ninguna respuesta simulada.'
        await recordUsage({
          requestId,
          source: 'chat',
          providerId: decision.route.providerId,
          requestedModelId: body.model ?? 'auto',
          resolvedModelId: decision.route.catalogModelId ?? decision.route.key,
          task: task ?? null,
          status: 'error',
          errorType,
          fallbackUsed: decision.fallbackUsed,
        })
        send('error', { message: safeMessage, errorType, requestId })
      } finally {
        controller.close()
      }
    },
    cancel() {
      abortController.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': requestId,
      ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}),
    },
  })
}
