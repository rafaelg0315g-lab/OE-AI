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

export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
  const baseSystem =
    body.mode === 'reflective'
      ? 'Eres OE AI LLM, el modelo unificado de OE BUSINESS. Responde con razonamiento paso a paso, cuidadoso y bien estructurado, usando markdown cuando ayude a la claridad.'
      : 'Eres OE AI LLM, el modelo unificado de OE BUSINESS. Responde de forma directa, clara y útil, usando markdown cuando ayude a la claridad.'
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
          'Estás en una conversación por VOZ en tiempo real. Responde SIEMPRE en español, con un tono natural, cálido y conversacional. Sé breve: como máximo dos o tres frases cortas por respuesta. PROHIBIDO usar markdown, listas, emojis, enlaces, negritas ni bloques de código: tu texto se convierte directamente en voz sintética y debe sonar bien leído en voz alta.',
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
