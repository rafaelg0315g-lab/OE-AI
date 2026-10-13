'use client'

/**
 * useOeChat — lógica del chat premium con OE AI LLM.
 *
 * - Comunica con POST /api/chat (SSE: meta → stage/search → delta → done | error).
 * - El backend entrega la respuesta completa (streaming de tokens no verificado);
 *   la revelación progresiva es un efecto de presentación local (máquina de
 *   escribir adaptativa) para una experiencia fluida, sin fingir datos.
 * - Gestiona historial multi-conversación vía /api/chat/sessions y
 *   /api/chat/history; herramientas: imágenes (/api/tools/image), búsqueda web
 *   real con fuentes, edición de mensajes (recorte), renombrar y exportar.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useUiStore, type ConversationSummary } from '@/lib/store/ui-store'
import { exportMessagesAsMarkdown } from '@/lib/export-chat'
import { useAuth } from '@/components/auth/auth-provider'

export interface WebSource {
  name: string
  url: string
  hostName: string
  snippet: string
  date: string | null
}

export interface ChatMsgMeta {
  /** Identificador del mensaje en el servidor (actualización del constructor). */
  messageId?: string | null
  coreLabel?: string | null
  routeNote?: string | null
  providerReportedModel?: string | null
  latencyMs?: number | null
  mode?: 'instant' | 'reflective'
  webSearchUsed?: boolean
  /** true: el turno analizó una imagen adjuntada (visión). */
  visionUsed?: boolean
  /** true: los deltas llegan incrementales en tiempo real (streaming verificado). */
  streaming?: boolean
}

/* ── Constructor de apps EN VIVO (SSE /api/tools/build-stream) ─────────── */

/** Tarea visible del panel de construcción (estilo lista de todos). */
export interface BuildLiveTodo {
  id: string
  label: string
  status: 'pending' | 'active' | 'done' | 'failed'
}

/** Archivo generado: disponible (y descargable) en cuanto el pipeline lo emite. */
export interface BuildLiveFile {
  path: string
  language: string
  bytes: number
  /** Contenido completo para el visor de código en vivo. */
  content?: string
  /** Descarga individual: /api/tools/build-app/[id]/download?path=… */
  url?: string
}

/** Snapshot del panel de construcción que vive dentro del mensaje. */
export interface BuildLiveSnapshot {
  kind: 'app' | 'web'
  status: 'building' | 'ready' | 'error'
  projectId?: string | null
  title?: string | null
  summary?: string | null
  todos: BuildLiveTodo[]
  files: BuildLiveFile[]
  /** Nota de etapa enviada por el servidor. */
  note?: string | null
  /** Descarga del proyecto completo (.zip) — solo cuando status=ready. */
  zipUrl?: string | null
  /** Vista previa iframe (sitios HTML estáticos del Web Factory). */
  previewUrl?: string | null
  isUpdate?: boolean
  changedPaths?: string[]
  latencyMs?: number | null
  error?: string | null
}

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  /** Texto visible (durante la revelación es un prefijo de fullContent). */
  content: string
  /** Texto completo recibido del proveedor. */
  fullContent: string
  /** true cuando la revelación terminó (render markdown). */
  complete: boolean
  meta?: ChatMsgMeta
  /** Tipo: texto normal o imagen generada por la herramienta del núcleo. */
  kind?: 'text' | 'image'
  /** Para kind="image": URL del activo servido por /api/assets/[id]. */
  assetUrl?: string | null
  /** Placeholder mientras se genera la imagen. */
  pendingImage?: boolean
  /** Etapa en vivo de la generación de imagen (SSE stage → animación aurora). */
  imageStage?: { note: string; elapsed: number } | null
  /** Constructor en vivo: tareas, código y descargas streaming. */
  build?: BuildLiveSnapshot | null
  /** true: placeholder aurora mientras se genera un video narrado. */
  pendingVideo?: boolean
  /** true: el constructor de apps está generando la app (aurora de puntos). */
  pendingProject?: boolean
  /** Fuentes web (búsqueda real) adjuntas a la respuesta. */
  sources?: WebSource[]
  /** Aviso honesto si la búsqueda web no estuvo disponible. */
  searchNote?: string | null
  /** Imagen adjuntada por el usuario (visión): /api/assets/[id]. */
  attachmentUrl?: string | null
  /** Fecha del servidor (solo mensajes restaurados del historial). */
  createdAt?: string | null
}

export type ChatPhase = 'idle' | 'thinking' | 'typing'

/** Resultado de las herramientas de medios (el diálogo muestra un toast honesto con él). */
export type ToolResult = { ok: boolean; error?: string; errorType?: string }

export interface ChatError {
  message: string
  errorType?: string
}

/** Cuota del chat para invitados: 5 chats gratis por sesión de navegador. */
export interface GuestQuotaState {
  used: number
  limit: number
  remaining: number
  exhausted: boolean
}

const ACTIVE_KEY = 'oe-ai-active-session'

/** Formato uuid v4 de los identificadores de conversación. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/* ── Constructor de apps / Web Factory: recuperación de builds ───────────── */

/** Proyecto según /api/tools/build-app/status (detalle completo). */
interface BuildStatusProject {
  id: string
  title?: string
  status?: string
  mode?: string
  stack?: string
  errorType?: string | null
  summary?: string
  createdAt: string
  files?: Array<{ path: string; language?: string; bytes?: number }>
  previewUrl?: string
  designSystem?: Record<string, string>
  references?: Array<{ name: string; repoUrl: string; license: string; usage: string }>
  checks?: Array<{ check: string; status: string; detail: string }>
  warnings?: string[]
}

/** Proyecto en versión ligera (lista del endpoint de estado). */
interface BuildStatusSummary {
  id: string
  title: string
  status: string
  mode: string
  errorType: string | null
  createdAt: string
  updatedAt: string
}

const BUILD_POLL_INTERVAL_MS = 4000
const BUILD_POLL_MAX_MS = 8 * 60_000

/** Explicación honesta del errorType del pipeline de construcción. */
function describeBuildError(errorType?: string | null): string {
  switch (errorType) {
    case 'no_files':
      return 'el núcleo no devolvió archivos utilizables (inténtalo de nuevo).'
    case 'build_interrupted':
      return 'la construcción se interrumpió (el servidor se reinició a mitad del proceso); pídela de nuevo y terminará en menos de 2 minutos.'
    case 'rate_limited':
      return 'el núcleo alcanzó su límite de peticiones; espera un momento e inténtalo de nuevo.'
    case 'empty_response':
      return 'el núcleo devolvió una respuesta vacía.'
    case 'json_parse':
      return 'la respuesta del núcleo no se pudo interpretar.'
    case 'provider_error':
      return 'el proveedor de código falló.'
    case 'invalid_plan':
      return 'el plan generado no fue válido.'
    case 'aborted':
      return 'la construcción se canceló.'
    default:
      return 'error interno del constructor.'
  }
}

/** Contenido del mensaje con el bloque ```oeproject (tarjetas de archivos). */
function oeProjectContent(
  prefix: string,
  data: {
    id: string
    title?: string
    summary?: string
    mode?: string
    stack?: string
    isUpdate?: boolean
    changedPaths?: string[]
    files?: Array<{ path: string; language?: string; bytes?: number }>
    previewUrl?: string
    designSystem?: Record<string, string>
    references?: Array<{ name: string; repoUrl: string; license: string; usage: string }>
    checks?: Array<{ check: string; status: string; detail: string }>
    warnings?: string[]
  },
  isWeb: boolean,
): string {
  const projectJson = JSON.stringify({
    id: data.id,
    title: data.title ?? (isWeb ? 'Sitio construido' : 'App construida'),
    summary: data.summary ?? '',
    mode: data.mode ?? (isWeb ? 'web' : 'frontend'),
    kind: isWeb ? 'web' : 'app',
    ...(data.isUpdate ? { isUpdate: true, changedPaths: data.changedPaths ?? [] } : {}),
    files: data.files ?? [],
    ...(isWeb
      ? {
          previewUrl: data.previewUrl,
          stack: data.stack,
          designSystem: data.designSystem,
          references: data.references,
          checks: data.checks,
          warnings: data.warnings,
        }
      : {}),
  })
  return `${prefix ? `${prefix}\n\n` : ''}\`\`\`oeproject\n${projectJson}\n\`\`\``
}

/** Nota de error persistida por el constructor (se usa en el healing). */
const BUILD_ERROR_NOTE_RE = /⚠️ No se pudo (?:construir|completar|iniciar) la (?:app|web|construcción)/

interface BuildDirectivePayload {
  name?: string
  brief: string
  mode?: string
  projectId?: string
  kind: 'app' | 'web'
  prefix: string
}

/**
 * Extrae la directiva del constructor de apps del texto del asistente.
 * Acepta TODAS las variantes que los núcleos emiten en la práctica:
 *  - ```oe-build\n{...}\n``` / ```oe-web\n{...}\n```  (canónica)
 *  - :::oe-build {...} ::: / :::oe-web\n{...}\n:::   (los modelos confunden la
 *    directiva con los bloques ricos :::cards/:::plan y la emiten con :::;
 *    sin este soporte el JSON crudo quedaba pegado en el chat y NUNCA
 *    arrancaba la construcción).
 * Localiza el marcador, extrae el primer objeto JSON balanceado que le sigue y
 * devuelve el brief + el anuncio previo (prefix).
 */
function extractBuildDirective(text: string): BuildDirectivePayload | null {
  const marker = /(?:```|:::)oe-(web|build)\b/.exec(text)
  if (!marker) return null
  const kind: 'app' | 'web' = marker[1] === 'web' ? 'web' : 'app'
  const jsonStart = text.indexOf('{', marker.index + marker[0].length)
  if (jsonStart === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return null
  try {
    const parsed = JSON.parse(text.slice(jsonStart, end + 1)) as {
      name?: unknown
      brief?: unknown
      mode?: unknown
      projectId?: unknown
    }
    const brief = typeof parsed.brief === 'string' ? parsed.brief.trim() : ''
    if (!brief) return null
    const prefix = text
      .slice(0, marker.index)
      .replace(/```[a-z]*\s*$/, '')
      .replace(/::{1,3}\s*$/, '')
      .trim()
    return {
      brief: brief.slice(0, 6000),
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : undefined,
      kind,
      prefix,
    }
  } catch {
    return null
  }
}

/** Restaura el último proyecto construido desde el historial (bloques oeproject). */
function extractLastBuildFromHistory(
  messages: Array<{ content: string }>,
): { projectId: string; title: string; files: string[]; kind: 'app' | 'web' } | null {
  const re = /```oeproject\s*\n([\s\S]*?)```/g
  let last: { projectId: string; title: string; files: string[]; kind: 'app' | 'web' } | null = null
  for (const m of messages) {
    let match: RegExpExecArray | null
    re.lastIndex = 0
    while ((match = re.exec(m.content)) !== null) {
      try {
        const data = JSON.parse(match[1]) as { id?: unknown; title?: unknown; kind?: unknown; files?: Array<{ path?: unknown }> }
        if (typeof data.id === 'string' && Array.isArray(data.files)) {
          last = {
            projectId: data.id,
            title: typeof data.title === 'string' ? data.title : 'App construida',
            files: data.files
              .map((f) => (typeof f?.path === 'string' ? f.path : ''))
              .filter(Boolean)
              .slice(0, 12),
            kind: data.kind === 'web' ? 'web' : 'app',
          }
        }
      } catch {
        // bloque inválido: ignorar
      }
    }
  }
  return last
}

export function useOeChat(options?: { initialChatId?: string }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [phase, setPhase] = useState<ChatPhase>('idle')
  const [error, setError] = useState<ChatError | null>(null)
  const [routeNote, setRouteNote] = useState<string | null>(null)
  const [focusModel, setFocusModel] = useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [lastUserMsg, setLastUserMsg] = useState<string | null>(null)
  const [webSearching, setWebSearching] = useState(false)
  const [imagePending, setImagePending] = useState(false)
  const [guestQuota, setGuestQuota] = useState<GuestQuotaState | null>(null)
  const [guestBlocked, setGuestBlocked] = useState(false)
  /** true cuando el chat de la URL (/c/<id>) es privado o no existe. */
  const [accessDenied, setAccessDenied] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const rafRef = useRef<number | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const pendingRef = useRef(false)
  const lastOptsRef = useRef<{ webSearch?: boolean; attachment?: { assetId: string; previewUrl: string } }>({})
  /** Último proyecto construido en la conversación activa (para modificaciones). */
  const lastBuildRef = useRef<{ projectId: string; title: string; files: string[]; kind: 'app' | 'web' } | null>(null)
  /** Chat solicitado por la ruta /c/<id> (estable durante la vida del componente). */
  const initialChatIdRef = useRef<string | null>(options?.initialChatId ?? null)
  const auth = useAuth()

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  /** Estado de la cuota (GET /api/chat/quota): nula si hay sesión iniciada.
   *  IMPORTANTE: envía el token de Supabase cuando existe — sin él el endpoint
   *  sigue viendo la cookie de invitado agotada y volvía a bloquear a usuarios
   *  que YA habían iniciado sesión (la respuesta asíncrona reactivaba la
   *  compuerta después de que el efecto la levantaba). */
  const refreshQuota = useCallback(async () => {
    try {
      const token = await auth.getAccessToken().catch(() => null)
      const res = await fetch('/api/chat/quota', {
        cache: 'no-store',
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      })
      if (!res.ok) return
      const data = (await res.json()) as {
        authenticated: boolean
        used: number | null
        limit: number | null
        remaining: number | null
        exhausted?: boolean
      }
      if (data.authenticated) {
        setGuestQuota(null)
        setGuestBlocked(false)
        return
      }
      const state: GuestQuotaState = {
        used: data.used ?? 0,
        limit: data.limit ?? 5,
        remaining: data.remaining ?? 0,
        exhausted: Boolean(data.exhausted),
      }
      setGuestQuota(state)
      // Con sesión iniciada el servidor ignora la cuota de invitado: nunca bloquear.
      if (state.exhausted && !auth.user) setGuestBlocked(true)
    } catch {
      // sin estado de cuota visible; el servidor seguirá aplicándola
    }
  }, [auth])

  // Cuota al arrancar y al cambiar la sesión (login/cierre): tras iniciar sesión
  // la compuerta se levanta (usuarios verificados: chats ilimitados).
  useEffect(() => {
    void refreshQuota()
    if (auth.user) setGuestBlocked(false)
  }, [auth.user, refreshQuota])

  // Sincroniza el enfoque de red (chatModel del store) con el estado local,
  // también cuando cambia estando montado (p. ej. "Usar en el chat" desde Conexiones).
  useEffect(() => {
    const syncFocus = (model: string) => {
      setFocusModel(model && model !== 'auto' ? model : null)
    }
    syncFocus(useUiStore.getState().chatModel)
    return useUiStore.subscribe((state) => syncFocus(state.chatModel))
  }, [])

  /** Lista de conversaciones para sidebar/buscador (solo usuarios verificados
   *  obtienen datos: el servidor filtra por propietario). */
  const refreshConversations = useCallback(async () => {
    try {
      const token = await auth.getAccessToken().catch(() => null)
      const res = await fetch('/api/chat/sessions', {
        cache: 'no-store',
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      })
      if (!res.ok) return
      const data = (await res.json()) as { sessions?: ConversationSummary[] }
      if (data.sessions) {
        setConversations(data.sessions.filter((s) => s.messageCount > 0))
        useUiStore.getState().setConversations(data.sessions.filter((s) => s.messageCount > 0))
      }
    } catch {
      // sin historial visible; la app sigue funcionando
    }
  }, [auth])

  /** Cabeceras con el token de Supabase (vacías para invitados). */
  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await auth.getAccessToken().catch(() => null)
    return token ? { Authorization: `Bearer ${token}` } : {}
  }, [auth])

  /**
   * Sincroniza la URL con el chat activo SIN recargar la vista
   * (replaceState): /c/<id> solo para usuarios verificados — los invitados
   * demo no tienen chats persistentes, así que permanecen en "/".
   */
  const syncUrlTo = useCallback(
    (id: string | null) => {
      if (!auth.user) return
      try {
        const url = id ? `/c/${id}` : '/'
        if (window.location.pathname !== url) {
          window.history.replaceState(null, '', url)
        }
      } catch {
        // entorno sin History API
      }
    },
    [auth.user],
  )

  /** Consulta el estado real de un build (apps y webs) sin cuota. */
  const fetchBuildStatus = useCallback(async (convId: string, projectId?: string): Promise<BuildStatusProject | null> => {
    try {
      const params = new URLSearchParams({ sessionId: convId })
      if (projectId) params.set('projectId', projectId)
      const res = await fetch(`/api/tools/build-app/status?${params.toString()}`, { cache: 'no-store' })
      if (!res.ok) return null
      const data = (await res.json().catch(() => null)) as { project?: BuildStatusProject | null } | null
      return data?.project ?? null
    } catch {
      return null
    }
  }, [])

  /**
   * Sondeo tras un fallo de conexión del POST de construcción (502 del gateway,
   * red, recarga): el build sigue en el servidor. Cuando el proyecto queda
   * listo, las tarjetas de archivos aparecen solas, sin recargar la página.
   */
  const resolveBuildByStatus = useCallback(
    async (args: {
      convId: string
      assistantId: string
      serverMessageId: string | null
      projectId?: string
      startedAt: number
      prefix: string
      isWeb: boolean
      fallbackError: string
    }) => {
      const { convId, assistantId, serverMessageId, projectId, startedAt, prefix, isWeb, fallbackError } = args
      const persist = (content: string) => {
        if (!serverMessageId) return
        void (async () => {
          const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) }
          await fetch('/api/chat/messages', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ id: serverMessageId, content }),
          }).catch(() => undefined)
        })()
      }
      const finish = (content: string, persistIt: boolean) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content, fullContent: content, pendingProject: false, complete: true } : m,
          ),
        )
        if (persistIt) persist(content)
      }
      const deadline = Date.now() + BUILD_POLL_MAX_MS
      let lastSeenBuilding = false
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, BUILD_POLL_INTERVAL_MS))
        const p = await fetchBuildStatus(convId, projectId)
        if (!p) continue
        const matches = p.id === projectId || new Date(p.createdAt).getTime() >= startedAt - 5000
        if (!matches) continue
        if (p.status === 'ready' && Array.isArray(p.files) && p.files.length > 0) {
          const newContent = oeProjectContent(prefix, p, isWeb)
          finish(newContent, true)
          lastBuildRef.current = {
            projectId: p.id,
            title: p.title ?? 'App construida',
            files: (p.files ?? []).map((f) => f.path).slice(0, 12),
            kind: isWeb ? 'web' : 'app',
          }
          void refreshQuota()
          void refreshConversations()
          return
        }
        if (p.status === 'error') {
          // Fallo definitivo del pipeline: nota honesta persistida.
          finish(`${prefix ? `${prefix}\n\n` : ''}⚠️ No se pudo completar la construcción: ${describeBuildError(p.errorType)}`, true)
          return
        }
        lastSeenBuilding = p.status === 'building'
      }
      if (lastSeenBuilding) {
        // El build sigue en curso tras el plazo: aviso SOLO local (sin PATCH)
        // para no borrar la directiva; al recargar, el healing la recupera.
        finish(`${prefix ? `${prefix}\n\n` : ''}⏳ La construcción sigue en curso en el servidor. Recarga la conversación en un momento para ver el resultado.`, false)
        return
      }
      finish(`${prefix ? `${prefix}\n\n` : ''}⚠️ No se pudo iniciar la construcción: ${fallbackError}`, true)
    },
    [fetchBuildStatus, refreshConversations, refreshQuota],
  )

  /**
   * Recuperación al cargar una conversación: mensajes con directiva
   * ```oe-build/```oe-web sin resolver (o nota de error del constructor) se
   * contrastan con el estado real del servidor. Si el proyecto terminó listo,
   * las tarjetas se muestran sin que el usuario tenga que hacer nada.
   */
  const healUnresolvedBuilds = useCallback(
    async (convId: string, msgs: ChatMsg[]) => {
      if (msgs.length === 0) return
      let projects: BuildStatusSummary[] | null = null
      try {
        const res = await fetch(`/api/tools/build-app/status?sessionId=${encodeURIComponent(convId)}`, { cache: 'no-store' })
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as { projects?: BuildStatusSummary[] } | null
          projects = data?.projects ?? null
        }
      } catch {
        return
      }
      if (!projects || projects.length === 0) return

      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        if (msg.role !== 'assistant') continue
        const content = msg.fullContent || msg.content
        if (content.includes('```oeproject')) continue
        const directive = extractBuildDirective(content)
        const isBuildErrorNote = !directive && BUILD_ERROR_NOTE_RE.test(content)
        if (!directive && !isBuildErrorNote) continue

        // Emparejar el mensaje con su proyecto: por projectId explícito
        // (modificaciones) o por ventana temporal (creación ≤ mensaje < siguiente).
        let match: BuildStatusSummary | undefined
        if (directive?.projectId) match = projects.find((p) => p.id === directive.projectId)
        if (!match) {
          const lower = msg.createdAt ? new Date(msg.createdAt).getTime() - 2000 : 0
          const nextWithTs = msgs.slice(i + 1).find((m) => m.createdAt)
          const upper = nextWithTs?.createdAt ? new Date(nextWithTs.createdAt).getTime() : Date.now() + 60_000
          match = projects.find((p) => {
            const ts = new Date(p.updatedAt || p.createdAt).getTime()
            return ts >= lower && ts <= upper
          })
        }
        if (!match) continue

        const detail = await fetchBuildStatus(convId, match.id)
        if (!detail) continue
        const isWeb = detail.mode === 'web'
        const waiting = isWeb ? 'Diseñando tu sitio web…' : 'Construyendo tu app…'
        const prefix = directive
          ? directive.prefix
          : content.split('\n⚠️')[0].replace(/```[a-z]*\s*$/, '').trim()

        if (detail.status === 'ready' && Array.isArray(detail.files) && detail.files.length > 0) {
          const newContent = oeProjectContent(prefix, detail, isWeb)
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msg.id ? { ...m, content: newContent, fullContent: newContent, pendingProject: false, complete: true } : m,
            ),
          )
          void (async () => {
            const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) }
            await fetch('/api/chat/messages', {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ id: msg.id, content: newContent }),
            }).catch(() => undefined)
          })()
          lastBuildRef.current = {
            projectId: detail.id,
            title: detail.title ?? 'App construida',
            files: (detail.files ?? []).map((f) => f.path).slice(0, 12),
            kind: isWeb ? 'web' : 'app',
          }
        } else if (detail.status === 'building') {
          // Reanudar en vivo: aurora + sondeo hasta la resolución real.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msg.id ? { ...m, content: prefix || waiting, fullContent: prefix || waiting, pendingProject: true, complete: true } : m,
            ),
          )
          await resolveBuildByStatus({
            convId,
            assistantId: msg.id,
            serverMessageId: msg.id,
            projectId: detail.id,
            startedAt: new Date(detail.createdAt).getTime(),
            prefix,
            isWeb,
            fallbackError: 'la construcción tardó demasiado en responder.',
          })
        } else if (detail.status === 'error') {
          const note = `${prefix ? `${prefix}\n\n` : ''}⚠️ No se pudo completar la construcción: ${describeBuildError(detail.errorType)}`
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msg.id ? { ...m, content: note, fullContent: note, pendingProject: false, complete: true } : m,
            ),
          )
          void (async () => {
            const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) }
            await fetch('/api/chat/messages', {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ id: msg.id, content: note }),
            }).catch(() => undefined)
          })()
        }
      }
    },
    [fetchBuildStatus, resolveBuildByStatus, authHeaders],
  )

  /**
   * Carga los mensajes de una conversación existente (texto e imágenes).
   * Devuelve true si se restauró; false si el chat es privado (404) o falló.
   */
  const loadConversation = useCallback(async (id: string): Promise<boolean> => {
    if (pendingRef.current) return false
    setError(null)
    setRouteNote(null)
    setLoadingHistory(true)
    try {
      const headers = await authHeaders()
      const res = await fetch(`/api/chat/history?sessionId=${encodeURIComponent(id)}`, {
        cache: 'no-store',
        ...(Object.keys(headers).length ? { headers } : {}),
      })
      if (!res.ok) {
        if (res.status === 404) {
          // PRIVACIDAD: el chat pertenece a otra cuenta o no existe. En la ruta
          // /c/<id> se muestra el aviso; en restauración local se ignora en silencio.
          if (initialChatIdRef.current === id) setAccessDenied(true)
          setMessages([])
          setActiveId(null)
          activeIdRef.current = null
          lastBuildRef.current = null
        }
        return false
      }
      const data = (await res.json()) as { messages?: Array<Record<string, unknown>> }
      const restored: ChatMsg[] = (data.messages ?? []).map((m) => {
        const kind = m.kind === 'image' ? 'image' : 'text'
        const role = m.role === 'user' ? ('user' as const) : ('assistant' as const)
        let sources: WebSource[] | undefined
        if (typeof m.sourcesJson === 'string' && m.sourcesJson) {
          try {
            const parsed = JSON.parse(m.sourcesJson) as WebSource[]
            if (Array.isArray(parsed) && parsed.length) sources = parsed
          } catch {
            // JSON inválido: se ignora
          }
        }
        // Snapshot del constructor en vivo (nuevos builds): reconstruye el panel.
        let build: BuildLiveSnapshot | null = null
        if (typeof m.buildJson === 'string' && m.buildJson) {
          try {
            const parsed = JSON.parse(m.buildJson) as BuildLiveSnapshot
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.todos) && Array.isArray(parsed.files)) {
              build = { ...parsed, status: parsed.status === 'building' ? 'ready' : parsed.status }
            }
          } catch {
            // JSON inválido: se ignora
          }
        }
        return {
          id: String(m.id),
          role,
          content: String(m.content ?? ''),
          fullContent: String(m.content ?? ''),
          complete: true,
          kind,
          assetUrl: kind === 'image' && typeof m.assetId === 'string' ? `/api/assets/${m.assetId}` : null,
          attachmentUrl: role === 'user' && typeof m.attachmentAssetId === 'string' ? `/api/assets/${m.attachmentAssetId}` : null,
          sources,
          build,
          createdAt: typeof m.createdAt === 'string' ? m.createdAt : null,
          meta: {
            providerReportedModel: (m.providerReportedModel as string) ?? null,
            routeNote: (m.resolvedModelId as string) ?? null,
          },
        }
      })
      setMessages(restored)
      setActiveId(id)
      activeIdRef.current = id
      setAccessDenied(false)
      syncUrlTo(id)
      // Continuidad del constructor: el último proyecto construido de ESTA conversación.
      lastBuildRef.current = extractLastBuildFromHistory(restored.map((m) => ({ content: m.fullContent })))
      // Builds nuevos: el snapshot vive en buildJson (prioridad sobre el bloque oeproject).
      const lastBuilt = [...restored].reverse().find((m) => m.build?.projectId)
      if (lastBuilt?.build?.projectId) {
        lastBuildRef.current = {
          projectId: lastBuilt.build.projectId,
          title: lastBuilt.build.title ?? 'App construida',
          files: lastBuilt.build.files.map((f) => f.path).slice(0, 12),
          kind: lastBuilt.build.kind,
        }
      }
      // Recuperación: directivas/notas de build sin resolver → estado real del servidor.
      void healUnresolvedBuilds(id, restored)
      try {
        window.localStorage.setItem(ACTIVE_KEY, id)
      } catch {
        // almacenamiento no disponible
      }
      return true
    } finally {
      setLoadingHistory(false)
    }
  }, [healUnresolvedBuilds, syncUrlTo, authHeaders])

  // Arranque: /c/<id> (ruta dedicada) o restauración del último chat del
  // usuario verificado. Los invitados demo siempre empiezan un chat nuevo y
  // su barra lateral no muestra historial.
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    if (auth.loading) return // esperar la restauración de sesión de Supabase
    bootedRef.current = true

    const initialId = initialChatIdRef.current
    if (initialId) {
      if (UUID_RE.test(initialId)) {
        void loadConversation(initialId)
      } else {
        setAccessDenied(true)
      }
      return
    }
    if (!auth.user) return // invitado: chat nuevo, sin historial (requisito demo)
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(ACTIVE_KEY)
    } catch {
      // sin almacenamiento
    }
    if (!stored || !UUID_RE.test(stored)) return
    void (async () => {
      const ok = await loadConversation(stored as string)
      if (!ok) {
        // Chat inaccesible o inexistente: chat nuevo limpio en "/".
        try {
          window.localStorage.removeItem(ACTIVE_KEY)
        } catch {
          // sin almacenamiento
        }
        syncUrlTo(null)
      }
    })()
  }, [auth.loading, auth.user, loadConversation, syncUrlTo])

  // Historial del sidebar: se refresca al arrancar y al iniciar/cerrar sesión
  // (el servidor devuelve solo las conversaciones propias del usuario).
  useEffect(() => {
    if (auth.loading) return
    void refreshConversations()
  }, [auth.user, auth.loading, refreshConversations])

  // Enfoque de red llegado desde el Centro de APIs (/apis)
  useEffect(() => {
    try {
      const pending = window.sessionStorage.getItem('oe-ai-pending-model')
      if (pending) {
        window.sessionStorage.removeItem('oe-ai-pending-model')
        useUiStore.getState().openChatWithModel(pending)
      }
    } catch {
      // ignorar
    }
    const focus = useUiStore.getState().chatModel
    if (focus && focus !== 'auto') setFocusModel(focus)
  }, [])

  /** Revelación progresiva tipo CASCADA (efecto GPT/Claude): los caracteres
   *  fluyen uno a uno a ritmo constante y legible (~90-180 c/s), con arranque
   *  enérgico y aterrizaje suave. Contenido estructurado (tablas/código):
   *  sin typewriter → render Markdown inmediato y bien formateado (nunca se
   *  ve la sintaxis cruda). */
  const startTypewriter = useCallback((assistantId: string, full: string) => {
    if (/```|(^|\n)\s*\|/.test(full)) {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: full, complete: true } : m)),
      )
      setPhase('idle')
      return
    }
    setPhase('typing')
    const total = full.length
    // Ritmo de cascada: 10 ms/char (≈100 c/s) con techo de 7 s para textos
    // largos y suelo de 1.1 s para respuestas cortas.
    const duration = Math.min(7000, Math.max(1100, total * 10))
    const start = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      // Ease-out suave: empieza con impulso y desacelera al final (cascada).
      const eased = 1 - Math.pow(1 - p, 1.55)
      const chars = Math.max(1, Math.floor(eased * total))
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: full.slice(0, chars) } : m)),
      )
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: full, complete: true } : m)),
        )
        setPhase('idle')
      }
    }
    rafRef.current = requestAnimationFrame(step)
  }, [])


  /** Envía un mensaje al modelo unificado OE AI LLM (con búsqueda web y/o imagen adjunta opcional). */
  const send = useCallback(
    async (
      rawText: string,
      opts?: {
        isRetry?: boolean
        webSearch?: boolean
        /** Imagen adjuntada (visión): el núcleo la analiza junto al texto. */
        attachment?: { assetId: string; previewUrl: string }
        /** Texto de documento leído (enlace/PDF): contexto efímero del turno. */
        docContext?: string
        /** Título del documento leído (se muestra en el prompt de sistema). */
        docTitle?: string
      },
    ) => {
      const content = rawText.trim()
      if (!content || pendingRef.current) return
      const mode = useUiStore.getState().mode
      const focus = useUiStore.getState().chatModel
      const webSearch = Boolean(opts?.webSearch)
      const attachment = opts?.attachment
      const docContext = typeof opts?.docContext === 'string' ? opts.docContext : undefined
      const docTitle = typeof opts?.docTitle === 'string' ? opts.docTitle : undefined
      lastOptsRef.current = { webSearch, attachment }

      // Conversación nueva si no hay una activa (URL /c/<id> para usuarios verificados)
      let convId = activeIdRef.current
      if (!convId) {
        convId = newId()
        activeIdRef.current = convId
        setActiveId(convId)
        try {
          window.localStorage.setItem(ACTIVE_KEY, convId)
        } catch {
          // sin almacenamiento
        }
      }
      syncUrlTo(convId)

      setError(null)
      setRouteNote(null)
      setPhase('thinking')
      setWebSearching(false)
      pendingRef.current = true
      if (!opts?.isRetry) {
        setLastUserMsg(content)
        setMessages((prev) => [
          ...prev,
          {
            id: `u-${newId()}`,
            role: 'user',
            content,
            fullContent: content,
            complete: true,
            attachmentUrl: attachment?.previewUrl ?? null,
          },
        ])
      }

      const assistantId = `a-${newId()}`
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '', fullContent: '', complete: false },
      ])

      const controller = new AbortController()
      abortRef.current = controller
      let doneMeta: ChatMsgMeta | null = null
      let serverStreaming = false
      let finalText = ''

      const handleEvent = (event: string, data: unknown) => {
        if (event === 'meta') {
          const meta = data as {
            routeNote?: string
            coreLabel?: string
            mode?: 'instant' | 'reflective'
            streaming?: boolean
            turn?: 'text' | 'image' | 'svg'
          }
          serverStreaming = Boolean(meta.streaming)
          if (meta.routeNote) setRouteNote(meta.routeNote)
          if (meta.turn === 'image') {
            // Turno de medios (imagen detectada en lenguaje natural): el marcador
            // de texto se convierte en tarjeta de imagen con placeholder.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      kind: 'image',
                      pendingImage: true,
                      meta: { ...m.meta, coreLabel: meta.coreLabel ?? null, routeNote: meta.routeNote ?? null },
                    }
                  : m,
              ),
            )
            return
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, meta: { ...m.meta, coreLabel: meta.coreLabel ?? null, routeNote: meta.routeNote ?? null, mode: meta.mode, streaming: serverStreaming } }
                : m,
            ),
          )
        } else if (event === 'stage') {
          const d = data as { stage?: string; note?: string; elapsed?: number }
          if (d.stage === 'web_search') setWebSearching(true)
          else if ((d.stage === 'image' || d.stage === 'svg_design') && d.note) {
            // Etapa en vivo de la generación de medios: alimenta la animación.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, imageStage: { note: d.note ?? '', elapsed: typeof d.elapsed === 'number' ? d.elapsed : 0 } }
                  : m,
              ),
            )
          }
        } else if (event === 'search') {
          const { sources } = data as { sources?: WebSource[] }
          setWebSearching(false)
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, sources: Array.isArray(sources) ? sources : [] } : m)),
          )
        } else if (event === 'search_error') {
          const { message } = data as { message?: string }
          setWebSearching(false)
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, searchNote: message ?? 'La búsqueda web no estuvo disponible.' } : m)),
          )
        } else if (event === 'delta') {
          const { text } = data as { text: string }
          if (serverStreaming) {
            // Streaming real del proveedor: cada delta es un incremento.
            setPhase('typing')
            finalText += text
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantId) return m
                const full = m.fullContent + text
                return { ...m, fullContent: full, content: full }
              }),
            )
          } else {
            // Respuesta única: revelación progresiva local (efecto de presentación).
            finalText = text
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, fullContent: text } : m)),
            )
            startTypewriter(assistantId, text)
          }
        } else if (event === 'image') {
          // Imagen generada dentro del turno de chat (intención detectada).
          const d = data as { url?: string; prompt?: string; latencyMs?: number }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    kind: 'image',
                    pendingImage: false,
                    complete: true,
                    content: d.prompt ?? m.content,
                    fullContent: d.prompt ?? m.fullContent,
                    assetUrl: d.url ?? null,
                    meta: { ...m.meta, latencyMs: d.latencyMs ?? null },
                  }
                : m,
            ),
          )
        } else if (event === 'done') {
          const d = data as {
            messageId?: string | null
            latencyMs?: number
            providerReportedModel?: string | null
            webSearchUsed?: boolean
            visionUsed?: boolean
          }
          doneMeta = {
            messageId: d.messageId ?? null,
            latencyMs: d.latencyMs ?? null,
            providerReportedModel: d.providerReportedModel ?? null,
            webSearchUsed: Boolean(d.webSearchUsed),
            visionUsed: Boolean(d.visionUsed),
          }
          if (serverStreaming) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.fullContent, complete: true } : m)),
            )
            setPhase('idle')
          }
        } else if (event === 'error') {
          const e = data as { message: string; errorType?: string }
          setError({ message: e.message, errorType: e.errorType })
          // Si ya había contenido parcial, se conserva completo; si no, se retira.
          setMessages((prev) =>
            prev
              .map((m) => (m.id === assistantId && m.fullContent ? { ...m, content: m.fullContent, complete: true } : m))
              .filter((m) => !(m.id === assistantId && !m.fullContent)),
          )
          setPhase('idle')
        }
      }

      try {
        const token = await auth.getAccessToken()
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            sessionId: convId,
            message: content,
            model: focus && focus !== 'auto' ? focus : undefined,
            allowFallback: true,
            mode,
            webSearch,
            attachmentId: attachment?.assetId,
            docContext,
            docTitle,
            buildContext: lastBuildRef.current
              ? {
                  projectId: lastBuildRef.current.projectId,
                  title: lastBuildRef.current.title.slice(0, 80),
                  files: lastBuildRef.current.files.slice(0, 12),
                  kind: lastBuildRef.current.kind,
                }
              : undefined,
          }),
          signal: controller.signal,
        })

        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => null)) as { error?: string; errorType?: string } | null
          throw Object.assign(new Error(data?.error ?? `Error ${res.status} al iniciar la conversación.`), {
            errorType: data?.errorType,
          })
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let sep: number
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            let eventName = 'message'
            let dataRaw = ''
            for (const line of rawEvent.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataRaw += line.slice(5).trim()
            }
            if (dataRaw) {
              try {
                handleEvent(eventName, JSON.parse(dataRaw))
              } catch {
                // evento malformado: ignorar de forma segura
              }
            }
          }
        }

        // Adjuntar metadatos finales (latencia, modelo reportado)
        if (doneMeta) {
          const meta = doneMeta as ChatMsgMeta
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, meta: { ...m.meta, ...meta } } : m)))
        }
        void refreshConversations()
        void refreshQuota()
        // Constructor de apps EN CONSTRUCCIÓN: ya no se lanzan builds automáticos.
        // Si el modelo emitiera una directiva oe-build/oe-web (legacy), el panel
        // del markdown muestra la tarjeta "En construcción" y el texto original
        // del asistente (con el JSON) NO se toca. El código se entrega como texto.
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          // Cancelación: si ya hay texto, se revela completo; si no, se retira el marcador.
          setMessages((prev) =>
            prev
              .map((m) => (m.id === assistantId && m.fullContent ? { ...m, content: m.fullContent, complete: true } : m))
              .filter((m) => !(m.id === assistantId && !m.fullContent)),
          )
        } else {
          const e = err as Error & { errorType?: string }
          if (e.errorType === 'guest_limit_reached') {
            // Cuota agotada: se activa la compuerta de inicio de sesión (sin error genérico).
            setGuestBlocked(true)
            void refreshQuota()
          } else {
            setError({ message: e.message, errorType: e.errorType })
          }
          setMessages((prev) => prev.filter((m) => m.id !== assistantId))
        }
      } finally {
        abortRef.current = null
        pendingRef.current = false
        setWebSearching(false)
        if (!rafRef.current) setPhase('idle')
      }
    },
    [auth, refreshConversations, refreshQuota, startTypewriter, syncUrlTo],
  )

  /** Genera una imagen con la herramienta del núcleo y la inserta en la conversación. */
  const generateImage = useCallback(
    async (rawPrompt: string) => {
      const prompt = rawPrompt.trim()
      if (!prompt || pendingRef.current) return

      let convId = activeIdRef.current
      if (!convId) {
        convId = newId()
        activeIdRef.current = convId
        setActiveId(convId)
        try {
          window.localStorage.setItem(ACTIVE_KEY, convId)
        } catch {
          // sin almacenamiento
        }
      }
      syncUrlTo(convId)

      setError(null)
      setRouteNote(null)
      setPhase('thinking')
      setImagePending(true)
      pendingRef.current = true
      setLastUserMsg(null) // la regeneración de texto no aplica tras una imagen
      setMessages((prev) => [
        ...prev,
        { id: `u-${newId()}`, role: 'user', content: prompt, fullContent: prompt, complete: true },
      ])

      const placeholderId = `img-${newId()}`
      setMessages((prev) => [
        ...prev,
        { id: placeholderId, role: 'assistant', content: '', fullContent: '', complete: false, kind: 'image', pendingImage: true },
      ])

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const token = await auth.getAccessToken()
        const res = await fetch('/api/tools/image', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ sessionId: convId, prompt }),
          signal: controller.signal,
        })
        const data = (await res.json().catch(() => null)) as {
          url?: string
          latencyMs?: number
          error?: string
          errorType?: string
        } | null
        if (!res.ok || !data?.url) {
          throw Object.assign(new Error(data?.error ?? `No se pudo generar la imagen (error ${res.status}).`), {
            errorType: data?.errorType,
          })
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  content: prompt,
                  fullContent: prompt,
                  assetUrl: data.url ?? null,
                  pendingImage: false,
                  complete: true,
                  meta: { latencyMs: data.latencyMs ?? null },
                }
              : m,
          ),
        )
        void refreshConversations()
        void refreshQuota()
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== placeholderId))
        if ((err as Error).name !== 'AbortError') {
          const e = err as Error & { errorType?: string }
          if (e.errorType === 'guest_limit_reached') {
            setGuestBlocked(true)
            void refreshQuota()
          } else {
            setError({ message: e.message, errorType: e.errorType })
          }
        }
      } finally {
        abortRef.current = null
        pendingRef.current = false
        setImagePending(false)
        setPhase('idle')
      }
    },
    [auth, refreshConversations, refreshQuota, syncUrlTo],
  )

  /** Creación de conversación (reutilizado por las herramientas de medios). */
  function ensureConversation(): string {
    let convId = activeIdRef.current
    if (!convId) {
      convId = newId()
      activeIdRef.current = convId
      setActiveId(convId)
      try {
        window.localStorage.setItem(ACTIVE_KEY, convId)
      } catch {
        // sin almacenamiento
      }
    }
    syncUrlTo(convId)
    return convId
  }

  /**
   * Genera un vídeo IA (POST /api/tools/video, puede tardar ~1-3 min) y lo
   * inserta en la conversación. El mensaje del asistente se guarda como
   * markdown de imagen con la pista `#video` en la URL: el renderer lo
   * convierte en <video controls> (contrato documentado en markdown.tsx).
   */
  const generateVideo = useCallback(
    async (input: { prompt: string; size?: string; duration?: number; withAudio?: boolean }): Promise<ToolResult> => {
      const prompt = input.prompt.trim()
      if (!prompt || pendingRef.current) return { ok: false, error: 'Ya hay una operación en curso.' }

      const convId = ensureConversation()

      setError(null)
      setRouteNote(null)
      setPhase('thinking')
      pendingRef.current = true
      setLastUserMsg(null)
      const userLabel = `Generar video: ${prompt}`
      setMessages((prev) => [
        ...prev,
        { id: `u-${newId()}`, role: 'user', content: userLabel, fullContent: userLabel, complete: true },
      ])

      const placeholderId = `vid-${newId()}`
      setMessages((prev) => [
        ...prev,
        { id: placeholderId, role: 'assistant', content: '', fullContent: '', complete: false, pendingVideo: true },
      ])

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const token = await auth.getAccessToken()
        const res = await fetch('/api/tools/video', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            sessionId: convId,
            prompt,
            size: input.size ?? '1024x1024',
            duration: input.duration ?? 5,
            withAudio: Boolean(input.withAudio),
          }),
          signal: controller.signal,
        })
        const data = (await res.json().catch(() => null)) as {
          url?: string
          durationSeconds?: number
          latencyMs?: number
          error?: string
          errorType?: string
        } | null
        if (!res.ok || !data?.url) {
          throw Object.assign(new Error(data?.error ?? `No se pudo generar el video (error ${res.status}).`), {
            errorType: data?.errorType,
          })
        }
        const content = `![Video generado](${data.url}#video)`
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  content,
                  fullContent: content,
                  complete: true,
                  pendingVideo: false,
                  meta: { latencyMs: data.latencyMs ?? null },
                }
              : m,
          ),
        )
        void refreshConversations()
        void refreshQuota()
        return { ok: true }
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== placeholderId))
        if ((err as Error).name === 'AbortError') return { ok: false, error: 'Generación cancelada.' }
        const e = err as Error & { errorType?: string }
        if (e.errorType === 'guest_limit_reached') {
          setGuestBlocked(true)
          void refreshQuota()
        } else {
          setError({ message: e.message, errorType: e.errorType })
        }
        return { ok: false, error: e.message, errorType: e.errorType }
      } finally {
        abortRef.current = null
        pendingRef.current = false
        setPhase('idle')
      }
    },
    [auth, refreshConversations, refreshQuota],
  )

  /**
   * Edita una imagen con IA (POST /api/tools/image-edit) y añade el resultado
   * a la conversación: mensaje del usuario con la imagen de referencia
   * (attachmentUrl, como visión) y respuesta con el markdown de la imagen.
   */
  const generateImageEdit = useCallback(
    async (input: { imageDataUrl: string; previewUrl: string; prompt: string }): Promise<ToolResult> => {
      const prompt = input.prompt.trim()
      if (!prompt || pendingRef.current) return { ok: false, error: 'Ya hay una operación en curso.' }

      // La edición de imagen no persiste en servidor (la ruta /api/tools/image-edit
      // no guarda mensajes): se asegura conversación activa para el turno local.
      ensureConversation()

      setError(null)
      setRouteNote(null)
      setPhase('thinking')
      pendingRef.current = true
      setLastUserMsg(null)
      setMessages((prev) => [
        ...prev,
        {
          id: `u-${newId()}`,
          role: 'user',
          content: `Editar imagen: ${prompt}`,
          fullContent: `Editar imagen: ${prompt}`,
          complete: true,
          attachmentUrl: input.previewUrl,
        },
      ])

      const placeholderId = `edt-${newId()}`
      setMessages((prev) => [
        ...prev,
        { id: placeholderId, role: 'assistant', content: '', fullContent: '', complete: false },
      ])

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const token = await auth.getAccessToken()
        const res = await fetch('/api/tools/image-edit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ image: input.imageDataUrl, prompt }),
          signal: controller.signal,
        })
        const data = (await res.json().catch(() => null)) as {
          url?: string
          latencyMs?: number
          error?: string
          errorType?: string
        } | null
        if (!res.ok || !data?.url) {
          throw Object.assign(new Error(data?.error ?? `No se pudo editar la imagen (error ${res.status}).`), {
            errorType: data?.errorType,
          })
        }
        const content = `![Imagen editada](${data.url})`
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  content,
                  fullContent: content,
                  complete: true,
                  meta: { latencyMs: data.latencyMs ?? null },
                }
              : m,
          ),
        )
        void refreshConversations()
        void refreshQuota()
        return { ok: true }
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== placeholderId))
        if ((err as Error).name === 'AbortError') return { ok: false, error: 'Edición cancelada.' }
        const e = err as Error & { errorType?: string }
        if (e.errorType === 'guest_limit_reached') {
          setGuestBlocked(true)
          void refreshQuota()
        } else {
          setError({ message: e.message, errorType: e.errorType })
        }
        return { ok: false, error: e.message, errorType: e.errorType }
      } finally {
        abortRef.current = null
        pendingRef.current = false
        setPhase('idle')
      }
    },
    [auth, refreshConversations, refreshQuota],
  )

  /** Detiene la generación, la revelación o la herramienta en curso. */
  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    pendingRef.current = false
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setPhase('idle')
    setWebSearching(false)
    setImagePending(false)
    setMessages((prev) => prev.map((m) => (m.complete || m.pendingImage ? m : { ...m, content: m.fullContent || m.content, complete: true })))
  }, [])

  /** Regenera la última respuesta (conserva la búsqueda web y la imagen adjunta del turno). */
  const regenerate = useCallback(() => {
    if (!lastUserMsg || pendingRef.current) return
    // Se elimina la última respuesta asistente incompleta o final
    setMessages((prev) => {
      const idx = prev.map((m) => m.role).lastIndexOf('assistant')
      return idx === -1 ? prev : prev.filter((_, i) => i !== idx)
    })
    void send(lastUserMsg, {
      isRetry: true,
      webSearch: lastOptsRef.current.webSearch,
      attachment: lastOptsRef.current.attachment,
    })
  }, [lastUserMsg, send])

  /**
   * Edita un mensaje del usuario: recorta la rama posterior (servidor y cliente)
   * y reenvía el texto corregido como mensaje nuevo. Si el mensaje original
   * tenía una imagen adjunta (visión), se reutiliza su attachmentAssetId —
   * mismo contrato que regenerate, que conserva el adjunto del turno.
   */
  const editMessage = useCallback(
    async (messageId: string, newContent: string) => {
      const text = newContent.trim()
      if (!text || pendingRef.current) return
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx === -1 || messages[idx]?.role !== 'user') return
      const convId = activeIdRef.current
      if (!convId) return

      // Adjunto de visión conservado: el assetId se deriva de la URL del preview.
      const original = messages[idx]
      let attachment: { assetId: string; previewUrl: string } | undefined
      if (original.attachmentUrl?.startsWith('/api/assets/')) {
        const assetId = original.attachmentUrl.slice('/api/assets/'.length)
        if (assetId) attachment = { assetId, previewUrl: original.attachmentUrl }
      }

      // Recorte en servidor: se conservan solo los mensajes anteriores a la edición.
      try {
        const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) }
        await fetch('/api/chat/trim', {
          method: 'POST',
          headers,
          body: JSON.stringify({ sessionId: convId, keepCount: idx }),
        })
      } catch {
        // si el recorte falla se continúa: la conversación local manda en la vista
      }
      setMessages((prev) => prev.slice(0, idx))
      void send(text, { attachment })
    },
    [messages, send, authHeaders],
  )

  /** Renombra una conversación (PATCH) y actualiza sidebar/buscador. */
  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const clean = title.trim().slice(0, 80)
      if (!clean) return
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: clean } : c)))
      useUiStore.setState((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: clean } : c)) }))
      try {
        const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) }
        await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ title: clean }),
        })
      } catch {
        // el título local se mantiene; el servidor quedará coherente al refrescar
      }
      void refreshConversations()
    },
    [refreshConversations, authHeaders],
  )

  /** Exporta la conversación activa como Markdown descargable. */
  const exportActiveConversation = useCallback(() => {
    if (messages.length === 0) return
    const title = conversations.find((c) => c.id === activeId)?.title ?? 'Conversación OE AI'
    exportMessagesAsMarkdown(title, messages)
  }, [activeId, conversations, messages])

  /** Nueva conversación (Ctrl+Shift+O). */
  const newChat = useCallback(() => {
    if (pendingRef.current) abortRef.current?.abort()
    activeIdRef.current = null
    setActiveId(null)
    setMessages([])
    setError(null)
    setRouteNote(null)
    setLastUserMsg(null)
    setFocusModel(null)
    setWebSearching(false)
    setImagePending(false)
    setAccessDenied(false)
    lastBuildRef.current = null
    syncUrlTo(null)
    try {
      window.localStorage.removeItem(ACTIVE_KEY)
      window.sessionStorage.removeItem('oe-ai-pending-model')
      useUiStore.setState({ chatModel: 'auto' })
    } catch {
      // sin almacenamiento
    }
  }, [syncUrlTo])

  /** Elimina una conversación del historial (solo el propietario puede). */
  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        const headers = await authHeaders()
        await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          ...(Object.keys(headers).length ? { headers } : {}),
        })
      } catch {
        // si falla, la lista se refresca igualmente
      }
      if (activeIdRef.current === id) newChat()
      void refreshConversations()
    },
    [newChat, refreshConversations, authHeaders],
  )

  // Limpieza al desmontar
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      abortRef.current?.abort()
    }
  }, [])

  const pending = phase !== 'idle'

  return {
    conversations,
    activeId,
    messages,
    phase,
    pending,
    error,
    routeNote,
    focusModel,
    loadingHistory,
    lastUserMsg,
    webSearching,
    imagePending,
    guestQuota,
    guestBlocked,
    accessDenied,
    refreshQuota,
    send,
    stop,
    regenerate,
    newChat,
    loadConversation,
    deleteConversation,
    refreshConversations,
    setFocusModel,
    generateImage,
    generateVideo,
    generateImageEdit,
    editMessage,
    renameConversation,
    exportActiveConversation,
  }
}

export type OeChatApi = ReturnType<typeof useOeChat>
