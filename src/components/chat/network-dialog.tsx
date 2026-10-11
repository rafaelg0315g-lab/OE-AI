'use client'

/**
 * Diálogo de CONEXIONES — la red de modelos que conforma OE AI LLM.
 *
 * - Diagrama animado: núcleo OE AI LLM conectado a las familias de la red.
 * - Contadores reales calculados desde el catálogo (128 modelos, N familias).
 * - Búsqueda por identificador y píldoras por familia con copia rápida.
 * - Todos los modelos se presentan como miembros de la red (sin estados de
 *   verificación individuales): OE AI LLM está listo.
 */
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BookOpen, Check, Copy, Cpu, MessageSquare, Search, X } from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { CATALOG, CATALOG_FAMILY_INDEX, type CatalogEntry } from '@/lib/ai/catalog/catalog'
import { CATEGORY_LABELS, type ProductCategory } from '@/lib/ai/types'
import { useUiStore } from '@/lib/store/ui-store'
import { cn } from '@/lib/utils'
import { OeLogo, ReadyBadge } from './oe-logo'

interface FamilyGroup {
  familyId: string
  label: string
  models: CatalogEntry[]
}

export function NetworkDialog() {
  const open = useUiStore((s) => s.networkOpen)
  const setOpen = useUiStore((s) => s.setNetworkOpen)
  const [query, setQuery] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  /** Estado de servicio real por modelo (desde /api/models); null mientras carga. */
  const [served, setServed] = useState<Map<string, { servable: boolean; connected: boolean }> | null>(null)

  // Evento global desde la pantalla de bienvenida
  useEffect(() => {
    const openNetwork = () => setOpen(true)
    window.addEventListener('oe-open-network', openNetwork)
    return () => window.removeEventListener('oe-open-network', openNetwork)
  }, [setOpen])

  // Estado de servicio real (una sola consulta al abrir el diálogo)
  useEffect(() => {
    if (!open || served) return
    let cancelled = false
    fetch('/api/models')
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data:
            | { models?: Array<{ id: string; status: string; providers?: Array<{ configured?: boolean }> }> }
            | null,
        ) => {
          if (!data?.models || cancelled) return
          const map = new Map<string, { servable: boolean; connected: boolean }>()
          for (const m of data.models) {
            map.set(m.id, {
              servable: Boolean(m.providers?.some((p) => p.configured)),
              connected: m.status === 'connected',
            })
          }
          setServed(map)
        },
      )
      .catch(() => {
        // sin datos de servicio: las píldoras conservan el comportamiento de copia
      })
    return () => {
      cancelled = true
    }
  }, [open, served])

  const servedCount = useMemo(
    () => (served ? [...served.values()].filter((v) => v.servable).length : null),
    [served],
  )

  // Agrupación por familia (orden alfabético por etiqueta)
  const groups = useMemo<FamilyGroup[]>(() => {
    const byFamily = new Map<string, FamilyGroup>()
    for (const entry of CATALOG) {
      let g = byFamily.get(entry.familyId)
      if (!g) {
        g = { familyId: entry.familyId, label: entry.familyLabel, models: [] }
        byFamily.set(entry.familyId, g)
      }
      g.models.push(entry)
    }
    return [...byFamily.values()].sort((a, b) => a.label.localeCompare(b.label, 'es'))
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups
      .map((g) => ({
        ...g,
        models: g.models.filter(
          (m) => m.id.toLowerCase().includes(q) || m.familyLabel.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.models.length > 0)
  }, [groups, query])

  function copyId(id: string) {
    void navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id)
      window.setTimeout(() => setCopiedId(null), 1600)
    })
  }

  const categoryChips: ProductCategory[] = ['general', 'reasoning', 'coding', 'fast', 'multilingual']

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="scrollbar-slim max-h-[88dvh] w-[min(1080px,94vw)] max-w-none gap-0 overflow-y-auto rounded-3xl border-border/70 bg-card p-0 sm:max-w-[min(1080px,94vw)]">
        <DialogHeader className="oe-hero-glow gap-3 border-b border-border/50 px-6 pb-5 pt-6">
          <div className="flex items-start gap-4">
            <OeLogo size="lg" />
            <div>
              <DialogTitle className="flex flex-wrap items-center gap-2.5 text-xl font-semibold tracking-tight">
                Red de modelos
                <ReadyBadge label="OE AI LLM listo" />
              </DialogTitle>
              <DialogDescription className="mt-1.5 max-w-2xl text-[13px] leading-relaxed">
                Los <span className="font-semibold text-foreground/85">{CATALOG.length} modelos</span> de{' '}
                {CATALOG_FAMILY_INDEX.length} familias conforman el modelo unificado{' '}
                <span className="font-semibold text-foreground/85">OE AI LLM</span>. Cada solicitud la procesa el
                modelo unificado y su enrutador interno asigna la ruta óptima dentro de la red.
              </DialogDescription>
            </div>
          </div>

          {/* Contadores reales + categorías orientativas */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge className="border-emerald-500/30 bg-emerald-500/12 text-emerald-200 hover:bg-emerald-500/20">
              {CATALOG.length} modelos
            </Badge>
            <Badge variant="outline" className="border-border/70 text-muted-foreground">
              {CATALOG_FAMILY_INDEX.length} familias
            </Badge>
            {servedCount !== null && (
              <Badge className="border-emerald-500/30 bg-emerald-500/12 text-emerald-200 hover:bg-emerald-500/20">
                {servedCount} servidos en vivo
              </Badge>
            )}
            {categoryChips.map((c) => (
              <Badge key={c} variant="outline" className="border-border/70 text-muted-foreground">
                {CATEGORY_LABELS[c]}
              </Badge>
            ))}
          </div>
        </DialogHeader>

        {/* Diagrama de conexiones */}
        <NetworkDiagram groups={groups} />

        {/* Búsqueda: pegajosa mientras el diálogo completo se desplaza */}
        <div className="sticky top-0 z-10 border-b border-border/50 bg-card/95 px-6 py-3 backdrop-blur">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar modelo en la red (p. ej. Kimi, Llama, GLM)…"
              aria-label="Buscar modelo en la red"
              className="rounded-xl border-border/60 bg-secondary/40 pl-9"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Limpiar búsqueda"
                className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
        </div>

        {/* Grupos por familia (el desplazamiento lo porta el diálogo completo) */}
        <div className="px-6 pt-5 pb-6">
          <motion.ul
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
            className="flex flex-col gap-4"
            aria-label="Familias de la red"
          >
            <AnimatePresence initial={false}>
              {filtered.map((g) => (
                <motion.li
                  key={g.familyId}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.25 }}
                  className="rounded-2xl border border-border/50 bg-secondary/25 p-4"
                >
                  <div className="mb-3 flex items-center gap-2.5">
                    <span className="grid size-8 place-items-center rounded-lg bg-emerald-500/12 ring-1 ring-emerald-500/25" aria-hidden>
                      <Cpu className="size-4 text-emerald-300" />
                    </span>
                    <h3 className="text-sm font-semibold tracking-tight">{g.label}</h3>
                    <Badge variant="outline" className="border-border/60 font-mono text-[10px] text-muted-foreground">
                      {g.models.length} {g.models.length === 1 ? 'modelo' : 'modelos'}
                    </Badge>
                    <span className="ml-auto hidden font-mono text-[10px] text-muted-foreground/70 sm:inline">
                      {`${g.familyId}/*`}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {g.models.map((m, i) => {
                      const visibleName = m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id
                      const isCopied = copiedId === m.id
                      const state = served?.get(m.id)
                      const isServable = Boolean(state?.servable)
                      const isConnected = Boolean(state?.connected)
                      return (
                        <motion.div
                          key={m.id}
                          initial={{ opacity: 0, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: Math.min(i * 0.015, 0.4), duration: 0.2 }}
                          role={isServable ? 'button' : undefined}
                          tabIndex={isServable ? 0 : undefined}
                          onClick={() => {
                            if (!isServable) return
                            useUiStore.getState().openChatWithModel(m.id)
                            setOpen(false)
                          }}
                          onKeyDown={(e) => {
                            if (!isServable) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              useUiStore.getState().openChatWithModel(m.id)
                              setOpen(false)
                            }
                          }}
                          title={isServable ? `Usar ${m.id} en el chat` : `${m.id} — clic en el icono para copiar`}
                          aria-label={
                            isServable
                              ? `Usar ${m.id} en el chat`
                              : `Copiar identificador ${m.id}`
                          }
                          className={cn(
                            'group flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all',
                            isServable && 'cursor-pointer hover:border-emerald-500/40 hover:bg-emerald-500/8',
                            !isServable &&
                              (isCopied
                                ? 'border-emerald-500/40 bg-emerald-500/10'
                                : 'border-border/40 bg-background/40'),
                            !isServable && !isCopied && 'hover:border-border/70 hover:bg-secondary/40',
                          )}
                        >
                            <span
                              className={cn(
                                'grid size-5 shrink-0 place-items-center rounded-md transition-colors',
                                isServable
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : isCopied
                                    ? 'bg-emerald-500/25'
                                    : 'bg-secondary/70 group-hover:bg-secondary',
                              )}
                              aria-hidden
                            >
                              {isServable ? (
                                <MessageSquare className="size-3" />
                              ) : isCopied ? (
                                <Check className="size-3 text-emerald-300" />
                              ) : (
                                <Copy className="size-3 text-muted-foreground" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] font-medium leading-tight">{visibleName}</span>
                              <span className="block truncate font-mono text-[10px] text-muted-foreground/80">{m.id}</span>
                            </span>
                            {!isServable && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  copyId(m.id)
                                }}
                                aria-label={`Copiar identificador ${m.id}`}
                                className="rounded-md p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
                              >
                                {isCopied ? <Check className="size-3 text-emerald-300" /> : <Copy className="size-3" />}
                              </button>
                            )}
                            <span
                              aria-hidden
                              className={cn(
                                'size-1.5 shrink-0 rounded-full',
                                isConnected
                                  ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]'
                                  : isServable
                                    ? 'bg-emerald-400/45'
                                    : 'bg-emerald-400/25',
                              )}
                              title={
                                isConnected
                                  ? 'Conectado: comprobación real superada'
                                  : isServable
                                    ? 'Servible: proveedor configurado sirve este modelo'
                                    : 'Miembro de la red OE AI LLM'
                              }
                            />
                        </motion.div>
                      )
                    })}
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>

          {filtered.length === 0 && (
            <div className="grid place-items-center py-12 text-center">
              <p className="text-sm text-muted-foreground">
                Ningún modelo coincide con «{query}».{' '}
                <button type="button" onClick={() => setQuery('')} className="font-medium text-emerald-300 underline underline-offset-2">
                  Limpiar búsqueda
                </button>
              </p>
            </div>
          )}

          {/* Nota de producto */}
          <div className="mt-5 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
                Conectado (comprobación real superada)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-1.5 rounded-full bg-emerald-400/45" />
                Servible (proveedor configurado)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-1.5 rounded-full bg-emerald-400/25" />
                Miembro de la red
              </span>
            </div>
            <p className="rounded-2xl border border-border/50 bg-secondary/25 p-4 text-xs leading-relaxed text-muted-foreground">
              Todos los modelos listados forman parte del modelo unificado OE AI LLM. Los marcados como servibles se
              procesan con su proveedor configurado al usarlos en el chat; el resto sale por el núcleo activo. En el{' '}
              <Link href="/apis" className="inline-flex items-center gap-1 font-medium text-emerald-300 underline underline-offset-2">
                Centro de APIs
                <BookOpen className="size-3" aria-hidden />
              </Link>{' '}
              puedes explorar el catálogo completo con familias, categorías orientativas y documentación.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Diagrama radial animado: núcleo OE AI LLM + familias conectadas con líneas
 * de flujo. Puro SVG/CSS, sin dependencias de grafos.
 */
function NetworkDiagram({ groups }: { groups: FamilyGroup[] }) {
  const nodes = groups
  const W = 760
  const H = 240
  const cx = W / 2
  const cy = H / 2
  const rx = 290
  const ry = 86

  return (
    <div className="relative border-t border-border/50 bg-background/30 px-6 py-4" aria-hidden>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mx-auto h-[210px] w-full max-w-3xl"
        role="img"
        aria-label={`Diagrama: OE AI LLM conectado a ${nodes.length} familias de modelos`}
      >
        <defs>
          <radialGradient id="oe-core" cx="50%" cy="45%" r="65%">
            <stop offset="0%" stopColor="oklch(0.85 0.12 168)" />
            <stop offset="100%" stopColor="oklch(0.6 0.11 172)" />
          </radialGradient>
        </defs>

        {/* Líneas de conexión con flujo animado */}
        {nodes.map((g, i) => {
          const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2
          const x = cx + Math.cos(angle) * rx
          const y = cy + Math.sin(angle) * ry
          return (
            <line
              key={`line-${g.familyId}`}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              className="oe-network-line"
              stroke="oklch(0.78 0.14 168 / 0.35)"
              strokeWidth="1.4"
            />
          )
        })}

        {/* Núcleo */}
        <circle cx={cx} cy={cy} r="46" fill="url(#oe-core)" opacity="0.16" />
        <circle cx={cx} cy={cy} r="34" fill="url(#oe-core)" opacity="0.9" />
        <text x={cx} y={cy - 3} textAnchor="middle" className="fill-emerald-950 text-[13px] font-bold">
          OE AI
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" className="fill-emerald-950 text-[9px] font-semibold opacity-80">
          LLM
        </text>

        {/* Nodos por familia (tamaño según número de modelos) */}
        {nodes.map((g, i) => {
          const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2
          const x = cx + Math.cos(angle) * rx
          const y = cy + Math.sin(angle) * ry
          const r = 4 + Math.min(7, Math.sqrt(g.models.length) * 2.4)
          return (
            <g key={`node-${g.familyId}`}>
              <circle cx={x} cy={y} r={r + 4} fill="oklch(0.78 0.14 168 / 0.1)" />
              <circle cx={x} cy={y} r={r} fill="oklch(0.8 0.13 168)" opacity="0.85">
                <title>{`${g.label} — ${g.models.length} ${g.models.length === 1 ? 'modelo' : 'modelos'}`}</title>
              </circle>
            </g>
          )
        })}
      </svg>
      <p className="mt-1 text-center text-[11px] text-muted-foreground">
        Cada familia aporta sus modelos a la red; el núcleo coordina y responde como un solo modelo.
      </p>
    </div>
  )
}
