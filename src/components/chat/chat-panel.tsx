'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowUp, Bot, Info, Loader2, Plus, RotateCcw, ShieldCheck, Square, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/lib/store/ui-store'

interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  providerLabel?: string | null
  providerReportedModel?: string | null
  routeLabel?: string | null
  fallbackUsed?: boolean
  requestedModelId?: string | null
}

interface RouteOption {
  key: string
  label: string
  providerId: string
  catalogModelId: string | null
}

const SESSION_KEY = 'oe-ai-session-id'

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export function ChatPanel() {
  const { chatModel, chatModelSetAt } = useUiStore()
  const [sessionId, setSessionId] = useState<string>('')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [routes, setRoutes] = useState<RouteOption[]>([])
  const [pending, setPending] = useState(false)
  const [lastError, setLastError] = useState<{ message: string; errorType?: string } | null>(null)
  const [routeNote, setRouteNote] = useState<string | null>(null)
  const [lastUserMsg, setLastUserMsg] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const modelRef = useRef(chatModel)

  useEffect(() => {
    modelRef.current = chatModel
  }, [chatModel, chatModelSetAt])

  // Recuperar preselección llegada desde la página /apis
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
  }, [])

  // Sesión anónima persistente (uuid en localStorage) + restauración de historial
  useEffect(() => {
    let id = window.localStorage.getItem(SESSION_KEY)
    if (!id) {
      id = newSessionId()
      window.localStorage.setItem(SESSION_KEY, id)
    }
    setSessionId(id)
    fetch(`/api/chat/history?sessionId=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { messages?: Array<Record<string, unknown>> } | null) => {
        if (!data?.messages) return
        const restored: ChatMsg[] = data.messages.map((m) => ({
          id: String(m.id),
          role: m.role === 'user' ? 'user' : 'assistant',
          content: String(m.content ?? ''),
          providerReportedModel: (m.providerReportedModel as string) ?? null,
          routeLabel: (m.resolvedModelId as string) ?? null,
          fallbackUsed: Boolean(m.fallbackUsed),
          requestedModelId: (m.requestedModelId as string) ?? null,
        }))
        setMessages(restored)
      })
      .catch(() => undefined)
  }, [])

  // Rutas servibles para el selector (solo las realmente configuradas)
  useEffect(() => {
    fetch('/api/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { routes?: RouteOption[] } | null) => {
        if (data?.routes) setRoutes(data.routes)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, pending])

  const modelOptions = useMemo(() => {
    const opts = [
      { key: 'auto', label: 'Automático (enrutador OE AI LLM)' },
      ...routes.map((r) => ({ key: r.key, label: r.label })),
    ]
    // Selección llegada desde el catálogo (/apis): mostrarla aunque la ruta
    // aún no esté configurada; el servidor responderá con un error honesto.
    if (chatModel !== 'auto' && !opts.some((o) => o.key === chatModel)) {
      opts.push({ key: chatModel, label: `${chatModel} (desde el catálogo)` })
    }
    return opts
  }, [routes, chatModel])

  const selectedLabel = useMemo(
    () => modelOptions.find((o) => o.key === chatModel)?.label ?? 'Automático (enrutador OE AI LLM)',
    [modelOptions, chatModel],
  )

  function stop() {
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
  }

  async function send(text: string, isRetry = false) {
    const content = text.trim()
    if (!content || pending || !sessionId) return
    setLastError(null)
    setRouteNote(null)
    setPending(true)
    if (!isRetry) {
      setLastUserMsg(content)
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content }])
      setInput('')
    } else {
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content }])
    }

    const assistantId = `a-${Date.now()}`
    setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '' }])

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: content, model: modelRef.current, allowFallback: true }),
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
      let streamFailed = false

      const handleEvent = (event: string, data: unknown) => {
        if (event === 'meta') {
          const meta = data as { routeNote?: string; fallbackUsed?: boolean; providerLabel?: string }
          if (meta.routeNote) setRouteNote(meta.routeNote)
          if (meta.fallbackUsed) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, fallbackUsed: true, providerLabel: meta.providerLabel ?? null } : m)),
            )
          }
        } else if (event === 'delta') {
          const { text } = data as { text: string }
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + text } : m)))
        } else if (event === 'done') {
          const d = data as { providerReportedModel?: string | null; fallbackUsed?: boolean }
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, providerReportedModel: d.providerReportedModel ?? null, fallbackUsed: d.fallbackUsed ?? m.fallbackUsed } : m)),
          )
        } else if (event === 'error') {
          const e = data as { message: string; errorType?: string }
          streamFailed = true
          setLastError({ message: e.message, errorType: e.errorType })
          setMessages((prev) => prev.filter((m) => m.id !== assistantId))
        }
      }

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
      if (!streamFailed) {
        setMessages((prev) => prev.map((m) => (m.id === assistantId && !m.content ? m : m)))
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId))
      } else {
        const e = err as Error & { errorType?: string }
        setLastError({ message: e.message, errorType: e.errorType })
        setMessages((prev) => prev.filter((m) => m.id !== assistantId))
      }
    } finally {
      abortRef.current = null
      setPending(false)
    }
  }

  function startNewConversation() {
    const id = newSessionId()
    window.localStorage.setItem(SESSION_KEY, id)
    setSessionId(id)
    setMessages([])
    setLastError(null)
    setRouteNote(null)
    setLastUserMsg(null)
  }

  const hasMessages = messages.length > 0

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem-4.25rem)] max-w-3xl flex-col gap-3 px-4 py-4 sm:px-6" aria-label="Chat de OE AI">
      {/* Barra superior del chat */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="model-select" className="sr-only">
            Selección de modelo
          </label>
          <Select value={chatModel} onValueChange={(v) => useUiStore.getState().openChatWithModel(v)}>
            <SelectTrigger id="model-select" className="w-full sm:w-[26rem]" aria-label="Modelo">
              <SelectValue placeholder="Automático" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {modelOptions.map((o) => (
                <SelectItem key={o.key} value={o.key}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3 shrink-0" aria-hidden />
            <span className="truncate" title={selectedLabel}>
              {selectedLabel}
            </span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={startNewConversation} className="gap-1.5">
          <Plus className="size-4" aria-hidden />
          Nueva conversación
        </Button>
      </div>

      {/* Aviso de ruta / fallback */}
      {routeNote && !lastError && (
        <Alert className="border-primary/30 bg-primary/5">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          <AlertDescription className="text-xs leading-relaxed text-foreground/85">{routeNote}</AlertDescription>
        </Alert>
      )}

      {/* Error honesto del proveedor */}
      {lastError && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>No se pudo completar la respuesta</AlertTitle>
          <AlertDescription className="flex flex-col gap-2 text-xs leading-relaxed">
            <span>{lastError.message}</span>
            <span className="text-muted-foreground">
              OE AI no simula respuestas cuando el proveedor falla. Si el problema persiste, revisa la configuración del
              proveedor en el servidor o elige “Automático”.
            </span>
            {lastUserMsg && (
              <Button size="sm" variant="outline" className="mt-1 w-fit gap-1.5" onClick={() => send(lastUserMsg, true)} disabled={pending}>
                <RotateCcw className="size-3.5" aria-hidden />
                Reintentar
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Lista de mensajes */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim rounded-xl border border-border/60 bg-card/40 p-4">
        {!hasMessages ? (
          <div className="grid h-full place-items-center">
            <div className="max-w-md text-center">
              <span className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-primary/15 ring-1 ring-primary/30">
                <Bot className="size-6 text-primary" aria-hidden />
              </span>
              <h2 className="text-lg font-semibold tracking-tight">Conversa con OE AI</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Las solicitudes pasan por <span className="font-medium text-foreground/85">OE AI LLM</span>, la capa que enruta
                cada mensaje hacia un proveedor configurado y devuelve la respuesta normalizada. Actualmente el enrutador
                dispone del modelo predeterminado del proveedor conectado; el resto del catálogo de 128 modelos está
                documentado en el Centro de APIs.
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-4" aria-live="polite">
            {messages.map((m) => (
              <li key={m.id} className={cn('flex gap-3', m.role === 'user' && 'justify-end')}>
                {m.role === 'assistant' && (
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/15 ring-1 ring-primary/25" aria-hidden>
                    <Bot className="size-4 text-primary" />
                  </span>
                )}
                <div className={cn('max-w-[85%] min-w-0', m.role === 'user' && 'flex flex-col items-end')}>
                  <div
                    className={cn(
                      'rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words',
                      m.role === 'user' ? 'bg-primary/15 text-foreground ring-1 ring-primary/25' : 'bg-secondary/70 text-foreground',
                    )}
                  >
                    {m.content || <span className="inline-flex items-center gap-2 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Pensando…</span>}
                  </div>
                  {m.role === 'assistant' && m.content && (m.providerReportedModel || m.fallbackUsed) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {m.fallbackUsed && (
                        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-300">
                          Fallback informado
                        </Badge>
                      )}
                      {m.providerReportedModel && (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          modelo informado por el proveedor: {m.providerReportedModel}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
                {m.role === 'user' && (
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-secondary ring-1 ring-border" aria-hidden>
                    <User className="size-4 text-foreground/80" />
                  </span>
                )}
              </li>
            ))}
            <div ref={bottomRef} />
          </ul>
        )}
      </div>

      {/* Composer */}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send(input)
            }
          }}
          placeholder="Escribe tu mensaje… (Enter para enviar, Shift+Enter para salto de línea)"
          rows={2}
          maxLength={8000}
          className="max-h-40 min-h-11 flex-1 resize-none scrollbar-slim"
          aria-label="Mensaje"
          disabled={pending}
        />
        {pending ? (
          <Button type="button" variant="destructive" size="icon" className="size-11 shrink-0" onClick={stop} aria-label="Detener respuesta">
            <Square className="size-4" aria-hidden />
          </Button>
        ) : (
          <Button type="submit" size="icon" className="size-11 shrink-0" disabled={!input.trim()} aria-label="Enviar mensaje">
            <ArrowUp className="size-4" aria-hidden />
          </Button>
        )}
      </form>
      <p className="text-center text-[11px] text-muted-foreground">
        Tus mensajes se envían a proveedores externos a través del servidor de OE AI. Sin cifrado de extremo a extremo;
        no compartas datos sensibles.
      </p>
    </div>
  )
}
