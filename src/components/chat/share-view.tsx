'use client'

/**
 * ShareView — vista pública de lectura de una conversación compartida (19-e).
 *
 * Se activa SOLO con ?share=<token> en la URL (sin token retorna null rápido:
 * el resto de la app ni se entera). Datos: GET /api/share/<token> (público,
 * el token es la única credencial). Render: tarjeta centrada de página
 * completa con la conversación en solo lectura; al cerrar se limpia ?share
 * con history.replaceState (sin recargar).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { AlertCircle, ExternalLink, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { OeLogo } from './oe-logo'
import { Markdown } from './markdown'
import { cn } from '@/lib/utils'

interface SharedMessage {
  role: string
  content: string
  attachmentUrl?: string
  imageUrl?: string
}

interface ShareData {
  title: string
  createdAt: string
  messages: SharedMessage[]
}

const SHARE_TOKEN_RE = /^[0-9a-f]{32}$/i

function subscribeNoop(_onChange: () => void): () => void {
  // La URL solo cambia por navegación completa (no hay suscripción real).
  return () => {}
}

/** Token ?share= de la URL (null si no existe o es malformado). */
function getShareTokenSnapshot(): string | null {
  const token = new URLSearchParams(window.location.search).get('share')
  return token && SHARE_TOKEN_RE.test(token) ? token : null
}

function formatDateEsCo(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso))
  } catch {
    return ''
  }
}

export function ShareView() {
  // window.location vía useSyncExternalStore (mismo patrón del composer para
  // la Web Speech API): snapshot nulo en servidor y re-chequeo tras hidratar
  // sin usar useSearchParams (evita exigir Suspense en el build).
  const urlToken = useSyncExternalStore(subscribeNoop, getShareTokenSnapshot, () => null)
  const [dismissed, setDismissed] = useState(false)

  const close = useCallback(() => {
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('share')
      const query = url.searchParams.toString()
      window.history.replaceState(null, '', url.pathname + (query ? `?${query}` : ''))
    } catch {
      // sin history disponible: solo se oculta la vista
    }
    setDismissed(true)
  }, [])

  const token = dismissed ? null : urlToken
  if (!token) return null
  return <ShareCard token={token} onClose={close} />
}

function ShareCard({ token, onClose }: { token: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ShareData | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: 'no-store' })
        const payload = (await res.json().catch(() => null)) as (ShareData & { error?: string }) | null
        if (cancelled) return
        if (res.status === 404) {
          setNotFound(true)
        } else if (!res.ok || !payload?.messages) {
          setError(payload?.error ?? 'No se pudo cargar la conversación compartida.')
        } else {
          setData({ title: payload.title, createdAt: payload.createdAt, messages: payload.messages })
        }
      } catch {
        if (!cancelled) setError('No se pudo cargar la conversación compartida.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[60] overflow-y-auto bg-background/95 backdrop-blur"
      role="dialog"
      aria-modal="true"
      aria-label="Vista compartida de conversación"
    >
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-10">
        {/* Cabecera */}
        <header className="mb-5 flex items-start gap-3 rounded-2xl border border-border/60 bg-secondary/50 p-4">
          <OeLogo size="sm" animated={false} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold tracking-tight">
              {loading ? <span className="oe-shimmer inline-block h-5 w-48 rounded bg-secondary/60" aria-hidden /> : data?.title}
            </h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {loading ? 'Cargando conversación…' : formatDateEsCo(data?.createdAt ?? '')}
            </p>
            <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              <ExternalLink className="size-3" aria-hidden />
              Vista compartida — solo lectura
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar vista compartida"
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        {/* Estados */}
        {loading && (
          <div className="flex flex-col gap-3" aria-live="polite" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={cn('oe-shimmer h-16 rounded-2xl bg-secondary/40', i % 2 === 1 ? 'ml-auto w-2/3' : 'w-full')}
                aria-hidden
              />
            ))}
            <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-emerald-300" aria-hidden />
              Cargando conversación…
            </p>
          </div>
        )}

        {!loading && notFound && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-center">
            <AlertCircle className="mx-auto size-8 text-amber-300" aria-hidden />
            <h2 className="mt-3 text-base font-semibold">Este enlace ya no es válido</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              La conversación fue eliminada o el enlace se revocó.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={onClose} className="border-border/60 bg-background/40">
                Cerrar
              </Button>
              <Button asChild className="bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 hover:from-emerald-300 hover:to-teal-500">
                <a href="/">Abrir OE AI</a>
              </Button>
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-2xl border border-border/60 bg-secondary/40 p-6 text-center">
            <AlertCircle className="mx-auto size-8 text-muted-foreground" aria-hidden />
            <h2 className="mt-3 text-base font-semibold">No se pudo cargar la conversación</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">{error}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={onClose} className="border-border/60 bg-background/40">
                Cerrar
              </Button>
            </div>
          </div>
        )}

        {/* Mensajes */}
        {!loading && data && (
          <>
            <div className="flex flex-col gap-3">
              {data.messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="ml-auto w-fit max-w-[85%]">
                    <div className="rounded-2xl rounded-br-lg bg-emerald-500/15 px-4 py-2.5 text-sm leading-relaxed ring-1 ring-emerald-500/25">
                      <p className="whitespace-pre-wrap break-words">{m.content}</p>
                    </div>
                    {m.attachmentUrl && (
                      <img
                        src={m.attachmentUrl}
                        alt="Imagen adjuntada por el usuario"
                        className="mt-1.5 max-h-72 w-auto max-w-full rounded-xl border border-border/60 object-contain"
                      />
                    )}
                  </div>
                ) : (
                  <div key={i} className="mr-auto w-fit max-w-[92%]">
                    <div className="rounded-2xl rounded-tl-lg bg-secondary/50 px-4 py-3 ring-1 ring-border/50">
                      {/* El markdown también renderiza los videos generados por IA (contrato #video). */}
                      <Markdown content={m.content} />
                      {/* Imagen generada (mensaje kind=image: el contenido es el prompt, la imagen va aparte). */}
                      {m.imageUrl && !m.content.includes('](') && (
                        <img
                          src={m.imageUrl}
                          alt="Imagen generada por la IA"
                          className="mt-2 max-h-80 w-auto max-w-full rounded-xl border border-border/60 object-contain"
                        />
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>

            <footer className="mt-6 flex flex-wrap justify-center gap-2 pb-6">
              <Button variant="outline" onClick={onClose} className="border-border/60 bg-background/40">
                Cerrar
              </Button>
              <Button asChild className="bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 hover:from-emerald-300 hover:to-teal-500">
                <a href="/">Abrir OE AI</a>
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
