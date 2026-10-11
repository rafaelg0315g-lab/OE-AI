'use client'

/**
 * Panel lateral de detalles de un modelo del catálogo (/apis).
 * Carga GET /api/models/<id codificado> al abrirse; muestra esqueletos durante
 * la carga y un estado de error con reintento. Toda la información es la que
 * devuelve la API: sin precios ni contextos inventados, sin botón de prueba
 * (solo administración) y «Chatear» únicamente cuando chatEnabled es verdadero.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Check,
  CircleDashed,
  Info,
  Link2,
  MessageSquare,
  RotateCw,
  TriangleAlert,
} from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/lib/store/ui-store'
import { CopyButton } from './model-card'
import { StatusBadge } from './status-badge'
import {
  CAPABILITY_LABELS_ES,
  formatDateTimeEs,
  visibleModelName,
  type ApiModelDetail,
} from './types'

interface ModelDetailsSheetProps {
  modelId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Texto honesto para el estado de una comprobación histórica. */
function checkStatusText(status: string): string {
  if (status === 'ok') return 'Correcta'
  if (status === 'error') return 'Fallida'
  return status
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  )
}

function SheetSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 flex-1" />
          <Skeleton className="size-9 rounded-md" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-14 rounded-lg" />
        <Skeleton className="h-14 rounded-lg" />
      </div>
      <Skeleton className="h-16 rounded-lg" />
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-24 rounded-lg" />
    </div>
  )
}

/** Botón «Copiar enlace» con confirmación textual temporal. */
function CopyLinkButton({ detailUrl }: { detailUrl: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = async () => {
    try {
      const url = `${window.location.origin}${detailUrl}`
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleCopy}
      aria-label="Copiar enlace del modelo"
      className="h-11 md:h-9"
    >
      {copied ? (
        <Check className="size-4 text-emerald-500" aria-hidden />
      ) : (
        <Link2 className="size-4" aria-hidden />
      )}
      {copied ? 'Enlace copiado' : 'Copiar enlace'}
    </Button>
  )
}

type DetailState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; detail: ApiModelDetail }

/**
 * Contenido del panel: se monta cada vez que se abre (key = modelId), por lo
 * que el estado inicial «loading» no necesita setState dentro del efecto.
 */
function DetailBody({
  modelId,
  onOpenChange,
}: {
  modelId: string
  onOpenChange: (open: boolean) => void
}) {
  const [state, setState] = useState<DetailState>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    fetch(`/api/models/${encodeURIComponent(modelId)}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) {
          const message =
            res.status === 404
              ? 'Este modelo no se encuentra en el catálogo. Puede que el enlace apunte a un identificador que ya no existe.'
              : 'No se pudo obtener el detalle del modelo. Inténtalo de nuevo en unos momentos.'
          throw new Error(message)
        }
        return (await res.json()) as ApiModelDetail
      })
      .then((detail) => {
        if (active) setState({ phase: 'ready', detail })
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return
        setState({
          phase: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Error inesperado al cargar el detalle del modelo.',
        })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [modelId, attempt])

  const detail = state.phase === 'ready' ? state.detail : null
  const name = detail ? visibleModelName(detail.id) : null

  const retry = () => {
    setState({ phase: 'loading' })
    setAttempt((n) => n + 1)
  }

  return (
    <>
      <SheetHeader className="gap-1.5 border-b border-border/60 p-4 pr-14 sm:p-6 sm:pr-14">
        {detail ? (
          <>
            <SheetTitle className="text-lg leading-tight">{name}</SheetTitle>
            <SheetDescription>
              {detail.familyLabel} · {detail.statusLabel}
            </SheetDescription>
          </>
        ) : (
          <>
            <SheetTitle>Cargando detalles del modelo…</SheetTitle>
            <SheetDescription>Leyendo el registro real del catálogo de OE AI.</SheetDescription>
          </>
        )}
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-slim sm:p-6">
        {state.phase === 'loading' && <SheetSkeleton />}

        {state.phase === 'error' && (
          <div className="space-y-4">
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <AlertTitle>No se pudo cargar el detalle</AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
            <Button type="button" variant="outline" onClick={retry} className="h-11 md:h-9">
              <RotateCw className="size-4" aria-hidden />
              Reintentar
            </Button>
          </div>
        )}

        {detail && (
          <div className="space-y-6">
            {/* Identificador exacto */}
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Identificador exacto
              </h3>
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs text-foreground/90">
                  {detail.id}
                </code>
                <CopyButton
                  value={detail.id}
                  label="Copiar identificador"
                  className="size-11 md:size-9"
                />
              </div>
            </section>

            {/* Familia + estado del servicio */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Familia
                </p>
                <p className="mt-1 text-sm font-medium">{detail.familyLabel}</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Estado del servicio
                </p>
                <div className="mt-1.5">
                  <StatusBadge
                    status={detail.status}
                    label={detail.statusLabel}
                    className="whitespace-normal"
                  />
                </div>
              </div>
            </div>

            {/* Uso orientativo (texto literal de la API) */}
            <p className="text-sm leading-relaxed text-muted-foreground">{detail.indicativeUse}</p>

            {/* Capacidades verificadas */}
            <DetailSection title="Capacidades verificadas">
              {detail.verifiedCapabilities.length > 0 ? (
                <ul className="space-y-1.5">
                  {detail.verifiedCapabilities.map((capability) => (
                    <li key={capability} className="flex items-center gap-2 text-sm">
                      <Check className="size-4 shrink-0 text-emerald-500" aria-hidden />
                      {CAPABILITY_LABELS_ES[capability] ?? capability}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CircleDashed className="size-4 shrink-0" aria-hidden />
                  Capacidades por verificar
                </p>
              )}
            </DetailSection>

            {/* Proveedores configurados */}
            <DetailSection title="Proveedores configurados">
              {detail.providers.length > 0 ? (
                <ul className="space-y-2">
                  {detail.providers.map((provider) => (
                    <li
                      key={provider.providerId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
                    >
                      <span className="text-sm font-medium">{provider.providerLabel}</span>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          aria-hidden
                          className={cn(
                            'size-1.5 rounded-full',
                            provider.configured ? 'bg-emerald-500' : 'bg-zinc-400',
                          )}
                        />
                        {provider.configured ? 'Configurado' : 'Sin configurar'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Ningún proveedor configurado sirve este modelo todavía
                </p>
              )}
            </DetailSection>

            {/* Última comprobación */}
            <DetailSection title="Última comprobación">
              <p className="text-sm">
                {detail.lastCheckedAt
                  ? formatDateTimeEs(detail.lastCheckedAt)
                  : 'Sin comprobaciones registradas todavía'}
              </p>
              {detail.lastCheckNote && (
                <p className="break-words text-sm leading-relaxed text-muted-foreground">
                  {detail.lastCheckNote}
                </p>
              )}
            </DetailSection>

            {/* Historial de comprobaciones (máx. 5) */}
            {detail.checks.length > 0 && (
              <DetailSection title="Historial de comprobaciones">
                <ul className="space-y-2">
                  {detail.checks.slice(0, 5).map((check) => (
                    <li
                      key={check.checkedAt}
                      className="rounded-lg border border-border/60 px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            check.status === 'ok'
                              ? 'bg-emerald-500'
                              : check.status === 'error'
                                ? 'bg-red-500'
                                : 'bg-zinc-400',
                          )}
                        />
                        <span className="text-sm font-medium">{checkStatusText(check.status)}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTimeEs(check.checkedAt)}
                          {check.latencyMs !== null ? ` · ${check.latencyMs} ms` : ''}
                        </span>
                      </div>
                      {check.note && (
                        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                          {check.note}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </DetailSection>
            )}

            {/* Notas informativas de coste y contexto (solo texto de la API) */}
            <DetailSection title="Coste y contexto">
              <div className="space-y-3 rounded-xl border border-border/60 bg-muted/30 p-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground/80">Precios: </span>
                  {detail.costNote}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground/80">Ventana de contexto: </span>
                  {detail.contextNote}
                </p>
              </div>
            </DetailSection>

            {/* Nota de familia, si existe */}
            {detail.familyNote && (
              <Alert>
                <Info className="size-4" />
                <AlertTitle>Nota de familia</AlertTitle>
                <AlertDescription>{detail.familyNote}</AlertDescription>
              </Alert>
            )}

            {/* Nota de revisión, si existe */}
            {detail.reviewNote && (
              <Alert variant="destructive">
                <TriangleAlert className="size-4" />
                <AlertTitle>Revisión necesaria</AlertTitle>
                <AlertDescription>{detail.reviewNote}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </div>

      {detail && (
        <SheetFooter className="flex-row items-center gap-2 border-t border-border/60 p-4 sm:p-6">
          {detail.chatEnabled && (
            <Button
              type="button"
              onClick={() => {
                useUiStore.getState().openChatWithModel(detail.id)
                onOpenChange(false)
              }}
              className="h-11 flex-1 md:h-9 md:flex-none"
            >
              <MessageSquare className="size-4" aria-hidden />
              Chatear
            </Button>
          )}
          <CopyLinkButton detailUrl={detail.detailUrl} />
        </SheetFooter>
      )}
    </>
  )
}

export function ModelDetailsSheet({ modelId, open, onOpenChange }: ModelDetailsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {modelId ? (
          <DetailBody key={modelId} modelId={modelId} onOpenChange={onOpenChange} />
        ) : (
          <SheetHeader className="p-4 pr-14 sm:p-6 sm:pr-14">
            <SheetTitle>Detalles del modelo</SheetTitle>
            <SheetDescription>Selecciona un modelo del catálogo.</SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  )
}
