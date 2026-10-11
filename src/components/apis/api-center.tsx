'use client'

/**
 * Centro de APIs de OE AI (/apis): catálogo público de la red que conforma
 * OE AI LLM con búsqueda, filtros, documentación y diagrama del enrutador.
 *
 * Marco de producto:
 *  - Los contadores provienen SIEMPRE de `counters` (calculados del registro real).
 *  - Los 128 modelos se presentan como miembros de la red de OE AI LLM (listo).
 *  - Sin botón de «Probar modelo» (solo administración) ni datos inventados.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes,
  CircleCheck,
  Layers,
  Info,
  MessageSquare,
  Network,
  RotateCw,
  Search,
  SearchX,
  Server,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useUiStore } from '@/lib/store/ui-store'
import { ApiDocs } from './api-docs'
import { CategoryChips, ModelCard } from './model-card'
import { ModelDetailsSheet } from './model-details-sheet'
import { RouterDiagram } from './router-diagram'
import { StatusBadge } from './status-badge'
import {
  CATEGORY_LABELS_ES,
  STATUS_LABELS_ES,
  STATUS_SORT_ORDER,
  formatDateTimeEs,
  visibleModelName,
  type ApiModel,
  type ApiModelsResponse,
  type ModelSortOption,
} from './types'

const COUNTERS_NOTE =
  'Contadores calculados desde el registro real del catálogo: la red completa conforma OE AI LLM.'

const STATUS_VALUES = Object.keys(STATUS_LABELS_ES) as Array<keyof typeof STATUS_LABELS_ES>

interface StatCardModel {
  key: string
  label: string
  value: string
  hint?: string
  icon: React.ReactNode
}

function CatalogListSkeleton() {
  return (
    <div className="mt-6" aria-hidden>
      <div className="grid grid-cols-1 gap-4 md:hidden">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="gap-3 rounded-xl border-border/60 p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-10 w-full" />
          </Card>
        ))}
      </div>
      <div className="hidden rounded-xl border border-border/60 p-4 md:block">
        <div className="space-y-3">
          {Array.from({ length: 9 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function ApiCenter() {
  const [data, setData] = useState<ApiModelsResponse | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const [rawSearch, setRawSearch] = useState('')
  const [search, setSearch] = useState('')
  const [family, setFamily] = useState('all')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState<ModelSortOption>('name_asc')

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoadState('loading')
    setErrorMessage(null)
    try {
      const res = await fetch('/api/models', { signal: controller.signal, cache: 'no-store' })
      if (!res.ok) {
        throw new Error('La API respondió con un estado inesperado.')
      }
      const payload = (await res.json()) as ApiModelsResponse
      setData(payload)
      setLoadState('ready')
    } catch (err: unknown) {
      if (controller.signal.aborted) return
      setData(null)
      setLoadState('error')
      setErrorMessage(
        err instanceof Error && err.message
          ? err.message
          : 'No se pudo cargar el catálogo de modelos.',
      )
    }
  }, [])

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [load])

  // Enlace profundo: /apis?model=<id codificado> abre el panel de detalles.
  useEffect(() => {
    const modelParam = new URLSearchParams(window.location.search).get('model')
    if (modelParam) {
      setSelectedModelId(modelParam)
      setSheetOpen(true)
    }
  }, [])

  // Búsqueda con retardo de 200 ms para no filtrar en cada pulsación.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(rawSearch), 200)
    return () => clearTimeout(timer)
  }, [rawSearch])

  const models = useMemo(() => data?.models ?? [], [data])

  const hasActiveFilters =
    rawSearch.trim().length > 0 || family !== 'all' || category !== 'all' || status !== 'all'

  const clearFilters = useCallback(() => {
    setRawSearch('')
    setSearch('')
    setFamily('all')
    setCategory('all')
    setStatus('all')
  }, [])

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase()
    const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true })

    const filtered = models.filter((model) => {
      if (query && !model.id.toLowerCase().includes(query) && !model.familyLabel.toLowerCase().includes(query)) {
        return false
      }
      if (family !== 'all' && model.familyId !== family) return false
      if (category !== 'all' && !model.categories.includes(category)) return false
      if (status !== 'all' && model.status !== status) return false
      return true
    })

    const sorted = [...filtered]
    sorted.sort((a, b) => {
      switch (sort) {
        case 'name_desc':
          return collator.compare(visibleModelName(b.id), visibleModelName(a.id))
        case 'family':
          return (
            collator.compare(a.familyLabel, b.familyLabel) ||
            collator.compare(visibleModelName(a.id), visibleModelName(b.id))
          )
        case 'status':
          return (
            STATUS_SORT_ORDER.indexOf(a.status) - STATUS_SORT_ORDER.indexOf(b.status) ||
            collator.compare(visibleModelName(a.id), visibleModelName(b.id))
          )
        case 'name_asc':
        default:
          return collator.compare(visibleModelName(a.id), visibleModelName(b.id))
      }
    })
    return sorted
  }, [models, search, family, category, status, sort])

  const openDetails = useCallback((modelId: string) => {
    setSelectedModelId(modelId)
    setSheetOpen(true)
  }, [])

  const openChat = useCallback((modelId: string) => {
    useUiStore.getState().openChatWithModel(modelId)
  }, [])

  const statCards: StatCardModel[] = useMemo(() => {
    const counters = data?.counters
    return [
      {
        key: 'total',
        label: 'Catálogo completo',
        value: counters ? String(counters.total) : '—',
        icon: <Boxes className="size-4" aria-hidden />,
      },
      {
        key: 'network',
        label: 'Conforman OE AI LLM',
        value: counters ? String(counters.networkMembers) : '—',
        icon: <Network className="size-4" aria-hidden />,
      },
      {
        key: 'connected',
        label: 'Conectados',
        value: counters ? String(counters.connected) : '—',
        hint: 'comprobación real superada',
        icon: <CircleCheck className="size-4" aria-hidden />,
      },
      {
        key: 'families',
        label: 'Familias conectadas',
        value: counters ? String(counters.families) : '—',
        icon: <Layers className="size-4" aria-hidden />,
      },
      {
        key: 'providers',
        label: 'Proveedores configurados',
        value: counters ? String(counters.providersConfigured) : '—',
        hint: counters ? `de ${counters.providersRegistered} registrados` : undefined,
        icon: <Server className="size-4" aria-hidden />,
      },
    ]
  }, [data])

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      {/* Hero */}
      <section className="oe-hero-glow oe-grid-lines rounded-2xl border border-border/60 p-6 sm:p-10">
        <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
          OE BUSINESS · OE AI LLM
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">OE AI APIs</h1>
        <p className="mt-2 text-lg text-foreground/85 sm:text-xl">
          Un ecosistema multimodelo. Una sola plataforma.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Los modelos de este catálogo conforman <span className="font-semibold text-foreground/85">OE AI LLM</span>,
          el modelo unificado de OE BUSINESS: cada solicitud la procesa el modelo unificado y su enrutador
          interno asigna la ruta óptima dentro de la red.
        </p>
        <Alert className="mt-6 border-emerald-500/40 bg-emerald-500/10">
          <Sparkles className="size-4 text-emerald-500 dark:text-emerald-300" aria-hidden />
          <AlertTitle className="text-emerald-800 dark:text-emerald-200">OE AI LLM está listo</AlertTitle>
          <AlertDescription className="text-emerald-900/90 dark:text-emerald-200/80">
            {data?.oeAiLlm.tagline ?? 'Red unificada de 128 modelos'} · núcleo activo conectado. Puedes conversar
            con el modelo unificado desde la interfaz principal o explorar cada modelo de la red a continuación.
          </AlertDescription>
        </Alert>
      </section>

      {/* Contadores reales */}
      <section aria-label="Contadores del catálogo" className="mt-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          {statCards.map((stat) => (
            <Card key={stat.key} className="gap-1.5 rounded-xl border-border/60 p-4">
              <div className="flex items-start justify-between gap-2">
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground"
                >
                  {stat.icon}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Más información sobre ${stat.label.toLowerCase()}`}
                      className="-m-1 rounded-full p-2.5 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:-m-1 sm:p-1.5"
                    >
                      <Info className="size-4 sm:size-3.5" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[240px] text-balance">
                    {COUNTERS_NOTE}
                  </TooltipContent>
                </Tooltip>
              </div>
              <p
                className="text-2xl font-semibold tabular-nums tracking-tight"
                title={data?.counters.source}
              >
                {stat.value}
              </p>
              {stat.hint && <p className="text-xs text-muted-foreground">{stat.hint}</p>}
              <p className="text-xs font-medium leading-snug text-muted-foreground">{stat.label}</p>
            </Card>
          ))}
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {COUNTERS_NOTE}
        </p>
      </section>

      {/* Barra de filtros */}
      <Card className="mt-6 gap-4 rounded-xl border-border/60 p-4 md:sticky md:top-16 md:z-20">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={rawSearch}
            onChange={(event) => setRawSearch(event.target.value)}
            placeholder="Buscar por nombre o ID…"
            aria-label="Buscar modelos por nombre o identificador"
            className="h-11 pl-9 md:h-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Select value={family} onValueChange={setFamily} disabled={!data}>
            <SelectTrigger aria-label="Filtrar por familia" className="h-11 w-full md:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las familias</SelectItem>
              {(data?.families ?? []).map((familyId) => (
                <SelectItem key={familyId} value={familyId}>
                  {familyId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={category} onValueChange={setCategory} disabled={!data}>
            <SelectTrigger aria-label="Filtrar por categoría" className="h-11 w-full md:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las categorías</SelectItem>
              {(data?.categories ?? []).map((categoryId) => (
                <SelectItem key={categoryId} value={categoryId}>
                  {CATEGORY_LABELS_ES[categoryId] ?? categoryId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={status} onValueChange={setStatus} disabled={!data}>
            <SelectTrigger aria-label="Filtrar por estado" className="h-11 w-full md:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los estados</SelectItem>
              {STATUS_VALUES.map((statusKey) => (
                <SelectItem key={statusKey} value={statusKey}>
                  {STATUS_LABELS_ES[statusKey]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sort} onValueChange={(value) => setSort(value as ModelSortOption)}>
            <SelectTrigger aria-label="Ordenar resultados" className="h-11 w-full md:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name_asc">Nombre A-Z</SelectItem>
              <SelectItem value="name_desc">Nombre Z-A</SelectItem>
              <SelectItem value="family">Familia</SelectItem>
              <SelectItem value="status">Estado</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {data ? (
            <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
              Mostrando {filteredModels.length} de {models.length} modelos
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Cargando catálogo…</p>
          )}
          {hasActiveFilters && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-11 md:h-8"
            >
              <X className="size-4" aria-hidden />
              Limpiar filtros
            </Button>
          )}
        </div>
      </Card>

      {/* Estado de error de carga */}
      {loadState === 'error' && (
        <div className="mt-6 space-y-4">
          <Alert variant="destructive">
            <TriangleAlert className="size-4" aria-hidden />
            <AlertTitle>No se pudo cargar el catálogo</AlertTitle>
            <AlertDescription>
              {errorMessage ?? 'Se produjo un error inesperado al consultar la API del catálogo.'}
            </AlertDescription>
          </Alert>
          <Button type="button" variant="outline" onClick={() => void load()} className="h-11 md:h-9">
            <RotateCw className="size-4" aria-hidden />
            Reintentar
          </Button>
        </div>
      )}

      {/* Catálogo */}
      {loadState === 'loading' && <CatalogListSkeleton />}

      {loadState === 'ready' && filteredModels.length === 0 && (
        <Card className="mt-6 items-center rounded-xl border-dashed border-border/60 p-8 text-center">
          <SearchX className="size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Ningún modelo coincide con los filtros aplicados</p>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
            Prueba con otro término de búsqueda o limpia los filtros para ver el catálogo completo.
          </p>
          {hasActiveFilters && (
            <Button
              type="button"
              variant="outline"
              onClick={clearFilters}
              className="mt-2 h-11 md:h-9"
            >
              <X className="size-4" aria-hidden />
              Limpiar filtros
            </Button>
          )}
        </Card>
      )}

      {loadState === 'ready' && filteredModels.length > 0 && (
        <>
          {/* Móvil: tarjetas */}
          <div className="mt-6 grid grid-cols-1 gap-4 md:hidden">
            {filteredModels.map((model) => (
              <ModelCard key={model.id} model={model} onOpenDetails={openDetails} />
            ))}
          </div>

          {/* Escritorio: tabla con cabecera fija */}
          <div className="mt-6 hidden md:block">
            <div className="max-h-[65vh] overflow-y-auto rounded-xl border border-border/60 bg-card scrollbar-slim [&_[data-slot=table-container]]:overflow-x-visible">
              <Table>
                <TableCaption className="sr-only">
                  Catálogo de modelos que conforman la red de OE AI LLM
                </TableCaption>
                <TableHeader className="sticky top-0 z-10 border-b border-border/60 bg-card/95 backdrop-blur">
                  <TableRow>
                    <TableHead>Modelo</TableHead>
                    <TableHead>Familia</TableHead>
                    <TableHead>Categorías</TableHead>
                    <TableHead>Red</TableHead>
                    <TableHead>Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredModels.map((model: ApiModel) => (
                    <TableRow key={model.id}>
                      <TableCell className="min-w-0">
                        <span
                          className="block max-w-[180px] truncate text-sm font-semibold lg:max-w-[220px]"
                          title={visibleModelName(model.id)}
                        >
                          {visibleModelName(model.id)}
                        </span>
                        <span
                          className="block max-w-[180px] truncate font-mono text-xs text-muted-foreground lg:max-w-[240px]"
                          title={model.id}
                        >
                          {model.id}
                        </span>
                      </TableCell>
                      <TableCell className="min-w-0">
                        <span
                          className="block max-w-[110px] truncate text-sm text-muted-foreground lg:max-w-[150px]"
                          title={model.familyLabel}
                        >
                          {model.familyLabel}
                        </span>
                      </TableCell>
                      <TableCell className="min-w-0">
                        <CategoryChips categories={model.categories} className="max-w-[170px]" />
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={model.status}
                          label={model.statusLabel}
                          className="whitespace-normal"
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1.5 xl:flex-row xl:items-center xl:justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openDetails(model.id)}
                            className="h-9"
                          >
                            Detalles
                          </Button>
                          {model.chatEnabled && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => openChat(model.id)}
                              className="h-9"
                            >
                              <MessageSquare className="size-3.5" aria-hidden />
                              Chatear
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}

      {/* Cómo funciona */}
      <section aria-labelledby="how-it-works-heading" className="mt-12">
        <h2 id="how-it-works-heading" className="text-xl font-semibold tracking-tight sm:text-2xl">
          Cómo funciona OE AI LLM
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          OE AI LLM es el modelo unificado de OE BUSINESS: coordina la red de {data?.counters.total ?? 128}{' '}
          modelos, asigna la ruta óptima para cada solicitud y devuelve una respuesta normalizada como
          un solo modelo.
        </p>
        <Card className="mt-4 rounded-xl border-border/60 p-4 sm:p-6">
          <RouterDiagram />
        </Card>
      </section>

      {/* Documentación */}
      <div className="mt-12">
        <ApiDocs />
      </div>

      {/* Nota de procedencia */}
      <section aria-labelledby="provenance-heading" className="mt-12">
        <Card className="rounded-xl border-border/60 bg-muted/30 p-4 sm:p-6">
          <h2
            id="provenance-heading"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Nota de procedencia
          </h2>
          {data?.sourceNote && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{data.sourceNote}</p>
          )}
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Los identificadores proceden del material fuente aportado; no se han verificado en
            tiempo real. Antes de habilitar un modelo en producción, comprueba la documentación,
            disponibilidad, nombre exacto, modalidad, precios y términos vigentes del proveedor.
          </p>
        </Card>
      </section>

      {/* Panel de detalles */}
      <ModelDetailsSheet
        modelId={selectedModelId}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  )
}
