'use client'

/**
 * OE AI Web Factory — Biblioteca de plantillas y componentes.
 *
 * - Catálogo real con procedencia y licencia de cada recurso (GitHub topics +
 *   HyperUI), cacheado en el servidor (/api/web-factory/catalog).
 * - Búsqueda instantánea por nombre/categoría/tecnología.
 * - Refresco bajo demanda desde GitHub (rate-limited en el servidor).
 * - Guía de uso: la generación se hace desde el chat pidiendo una web
 *   profesional (el asistente emite la directiva oe-web).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Globe, Layers, Loader2, RefreshCw, Search, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useUiStore } from '@/lib/store/ui-store'
import { cn } from '@/lib/utils'

interface CatalogTemplate {
  name: string
  repoUrl: string
  category: string
  tech: string
  description: string
  licenseSpdx: string | null
  licenseVerified: boolean
  stars: number
  status: string
  notes?: string | null
  source: string
}

interface CatalogComponent {
  name: string
  category: string
  tech: string
  description: string
  licenseSpdx: string | null
  repoUrl: string | null
  source: string
}

interface CatalogResponse {
  counts?: { templates: number; components: number }
  updatedAt?: string | null
  templates?: CatalogTemplate[]
  components?: CatalogComponent[]
  error?: string
}

const CATEGORY_LABELS: Record<string, string> = {
  landing: 'Landing pages', corporativo: 'Corporativo', saas: 'SaaS', ia: 'IA',
  ecommerce: 'Comercio', agencia: 'Agencias', portfolio: 'Portafolios',
  restaurante: 'Restaurantes', turismo: 'Turismo', inmobiliaria: 'Inmobiliaria',
  educacion: 'Educación', finanzas: 'Finanzas', admin: 'Administración',
  dashboard: 'Dashboards', blog: 'Blogs y medios', producto: 'Producto', auth: 'Auth',
  hero: 'Heroes', nav: 'Navegación', pricing: 'Precios', testimonios: 'Testimonios',
  cta: 'Llamadas a la acción', footer: 'Footers', faq: 'FAQ', features: 'Características',
  stats: 'Estadísticas', logos: 'Logos', galeria: 'Galerías', form: 'Formularios', team: 'Equipo',
}

const SOURCE_LABELS: Record<string, string> = {
  hyperui: 'HyperUI',
  hugoblox: 'HugoBlox Kit',
  daisyui: 'daisyUI',
  uupm: 'UI UX Pro Max',
  github: 'GitHub',
}

export function WebFactoryDialog() {
  const open = useUiStore((s) => s.webFactoryOpen)
  const setOpen = useUiStore((s) => s.setWebFactoryOpen)
  const [data, setData] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'plantillas' | 'componentes'>('plantillas')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/web-factory/catalog')
      setData((await res.json()) as CatalogResponse)
    } catch {
      setNote('No se pudo cargar el catálogo. Revisa tu conexión.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || data) return
    void load()
  }, [open, data, load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setNote(null)
    try {
      const res = await fetch('/api/web-factory/catalog', { method: 'POST' })
      const json = (await res.json()) as { note?: string; error?: string }
      setNote(json.note ?? json.error ?? null)
      setData(null)
      await load()
    } catch {
      setNote('El refresco desde GitHub falló. El catálogo curado sigue disponible.')
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const filteredTemplates = useMemo(() => {
    const list = data?.templates ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((t) =>
      `${t.name} ${t.category} ${t.tech} ${t.description}`.toLowerCase().includes(q),
    )
  }, [data, query])

  const filteredComponents = useMemo(() => {
    const list = data?.components ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((c) => `${c.name} ${c.category} ${c.tech}`.toLowerCase().includes(q))
  }, [data, query])

  const byCategory = useMemo(() => {
    const map = new Map<string, CatalogComponent[]>()
    for (const c of filteredComponents) {
      const arr = map.get(c.category) ?? []
      arr.push(c)
      map.set(c.category, arr)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filteredComponents])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[88svh] max-w-[96vw] flex-col gap-3 rounded-2xl border-border/70 bg-background p-4 sm:max-w-[860px]">
        <DialogHeader className="shrink-0 space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Globe className="size-4 text-emerald-300" aria-hidden />
            OE AI Web Factory · Biblioteca
          </DialogTitle>
          <DialogDescription className="text-xs">
            Plantillas y componentes de referencia (GitHub · HyperUI) con su licencia verificada. Para generar un sitio, pídelo en el chat: «Crea una web profesional para…» y OE AI lo construye con este catálogo.
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-border/60 bg-secondary/40 p-1">
            {(['plantillas', 'componentes'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                  tab === t ? 'bg-emerald-500/15 text-emerald-200' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'plantillas' ? 'Plantillas' : 'Secciones'}
              </button>
            ))}
          </div>
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre, categoría o tecnología…"
              className="h-9 border-border/60 bg-secondary/40 pl-8 text-[13px]"
              aria-label="Buscar en el catálogo"
            />
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-secondary/50 px-3 py-2 text-[12px] font-medium text-foreground/85 transition-colors hover:border-emerald-500/40 hover:text-emerald-200 disabled:opacity-60"
            aria-label="Actualizar catálogo desde GitHub"
          >
            {refreshing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
            Actualizar
          </button>
        </div>

        {note && (
          <p className="shrink-0 rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 text-[11.5px] text-muted-foreground" role="status">
            {note}
          </p>
        )}

        <div className="scrollbar-slim flex-1 overflow-y-auto rounded-xl border border-border/60 bg-secondary/20 p-3" style={{ maxHeight: '58svh' }}>
          {loading && !data ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Cargando catálogo…
            </div>
          ) : tab === 'plantillas' ? (
            <ul className="flex flex-col gap-2" aria-label="Plantillas del catálogo">
              {filteredTemplates.map((t) => (
                <li key={t.repoUrl} className="rounded-xl border border-border/60 bg-secondary/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] font-semibold text-foreground/95">{t.name}</p>
                    {t.licenseVerified ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                        <ShieldCheck className="size-3" aria-hidden />
                        {t.licenseSpdx ?? 'MIT'}
                      </span>
                    ) : (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                        <TriangleAlert className="size-3" aria-hidden />
                        Solo referencia
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{t.description}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
                    <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5">{CATEGORY_LABELS[t.category] ?? t.category}</span>
                    <span>{t.tech}</span>
                    {t.stars > 0 && <span>★ {t.stars.toLocaleString('es')}</span>}
                    <span className={cn('font-medium', t.status === 'activo' ? 'text-emerald-300/80' : 'text-amber-300/80')}>
                      {t.status === 'activo' ? 'Reutilizable según licencia' : 'Inspiración visual (sin copiar código)'}
                    </span>
                    <a href={t.repoUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-emerald-300 hover:underline">
                      Repositorio <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </div>
                </li>
              ))}
              {filteredTemplates.length === 0 && <li className="py-6 text-center text-xs text-muted-foreground">Sin resultados para «{query}».</li>}
            </ul>
          ) : (
            <div className="flex flex-col gap-3" aria-label="Componentes del catálogo">
              {byCategory.map(([category, items]) => (
                <div key={category}>
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Layers className="size-3" aria-hidden />
                    {CATEGORY_LABELS[category] ?? category}
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {items.map((c) => (
                      <div key={`${c.source}-${c.name}`} className="rounded-lg border border-border/50 bg-secondary/30 px-2.5 py-2">
                        <p className="truncate text-[12px] font-medium text-foreground/90">{c.name}</p>
                        <p className="text-[10.5px] text-muted-foreground">
                          {c.tech} · {c.licenseSpdx ?? 'sin licencia'} · {SOURCE_LABELS[c.source] ?? 'Curado'}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {byCategory.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">Sin resultados para «{query}».</p>}
            </div>
          )}
        </div>

        {data?.counts && (
          <p className="shrink-0 text-center text-[10.5px] text-muted-foreground">
            {data.counts.templates} plantillas · {data.counts.components} secciones · código final siempre propio de OE AI (patrones, no copias)
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
