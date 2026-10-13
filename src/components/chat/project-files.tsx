'use client'

/**
 * Tarjetas de archivos del Constructor de Apps y de OE AI Web Factory:
 * - Un bloque ```oeproject en el mensaje del asistente contiene el JSON con el
 *   proyecto {id, title, summary, files:[{path, language, bytes}]} (y, en webs,
 *   previewUrl + referencias + validación).
 * - Cada archivo se muestra como tarjeta con icono de tipo, nombre legible y
 *   botón "Descargar" (attachment individual).
 * - "Descargar todo" empaqueta el proyecto completo en un .zip (servidor).
 * - Webs de Web Factory: botón "Vista previa" (escritorio/tablet/móvil con
 *   iframe real), procedencia y resumen de validación.
 * - Bloques ```oe-build/```oe-web residuales muestran la tarjeta "En construcción"
 *   (el entorno .zip está desactivado: el código se entrega como texto del chat).
 */
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Braces,
  Check,
  Code2,
  Download,
  ExternalLink,
  Eye,
  FileCode,
  FileText,
  Globe,
  HardHat,
  Image as ImageIcon,
  Info,
  Monitor,
  Palette,
  Smartphone,
  Tablet,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export interface ProjectFilesData {
  id: string
  title: string
  summary?: string
  mode?: string
  kind?: 'app' | 'web'
  isUpdate?: boolean
  changedPaths?: string[]
  files: Array<{ path: string; language?: string; bytes?: number }>
  /** OE AI Web Factory */
  previewUrl?: string
  stack?: string
  designSystem?: Record<string, string>
  references?: Array<{ name: string; repoUrl: string; license: string; usage: string }>
  checks?: Array<{ check: string; status: string; detail: string }>
  warnings?: string[]
}

/** Parsea el JSON de un bloque ```oeproject (tolerante a datos incompletos). */
export function parseProjectFiles(raw: string): ProjectFilesData | null {
  try {
    const data = JSON.parse(raw) as Partial<ProjectFilesData> & { files?: unknown }
    if (!data || typeof data.id !== 'string' || !Array.isArray(data.files) || data.files.length === 0) return null
    const files = data.files
      .map((f) => {
        const rec = (f ?? {}) as { path?: unknown; language?: unknown; bytes?: unknown }
        return {
          path: typeof rec.path === 'string' ? rec.path : '',
          language: typeof rec.language === 'string' ? rec.language : undefined,
          bytes: typeof rec.bytes === 'number' ? rec.bytes : undefined,
        }
      })
      .filter((f) => f.path)
    if (files.length === 0) return null
    return {
      id: data.id,
      title: typeof data.title === 'string' && data.title ? data.title : 'App construida',
      summary: typeof data.summary === 'string' ? data.summary : undefined,
      mode: typeof data.mode === 'string' ? data.mode : undefined,
      kind: data.kind === 'web' ? 'web' : data.mode === 'web' ? 'web' : 'app',
      isUpdate: Boolean(data.isUpdate),
      changedPaths: Array.isArray(data.changedPaths) ? data.changedPaths.filter((p): p is string => typeof p === 'string') : [],
      files,
      previewUrl: typeof data.previewUrl === 'string' ? data.previewUrl : undefined,
      stack: typeof data.stack === 'string' ? data.stack : undefined,
      designSystem:
        data.designSystem && typeof data.designSystem === 'object'
          ? (Object.fromEntries(Object.entries(data.designSystem).map(([k, v]) => [k, String(v)])) as Record<string, string>)
          : undefined,
      references: Array.isArray(data.references)
        ? data.references
            .map((r) => {
              const rec = (r ?? {}) as { name?: unknown; repoUrl?: unknown; license?: unknown; usage?: unknown }
              return {
                name: typeof rec.name === 'string' ? rec.name : '',
                repoUrl: typeof rec.repoUrl === 'string' ? rec.repoUrl : '',
                license: typeof rec.license === 'string' ? rec.license : '',
                usage: typeof rec.usage === 'string' ? rec.usage : 'referencia-visual',
              }
            })
            .filter((r) => r.name && r.repoUrl)
        : undefined,
      checks: Array.isArray(data.checks)
        ? data.checks
            .map((c) => {
              const rec = (c ?? {}) as { check?: unknown; status?: unknown; detail?: unknown }
              return {
                check: typeof rec.check === 'string' ? rec.check : '',
                status: typeof rec.status === 'string' ? rec.status : 'no-ejecutada',
                detail: typeof rec.detail === 'string' ? rec.detail : '',
              }
            })
            .filter((c) => c.check)
        : undefined,
      warnings: Array.isArray(data.warnings) ? data.warnings.map(String).slice(0, 12) : undefined,
    }
  } catch {
    return null
  }
}

/** Nombre legible de un archivo de proyecto: index.html → "Index". */
function prettyName(path: string): string {
  const base = path.split('/').pop() ?? path
  const withoutExt = base.replace(/\.[a-z0-9]+$/i, '')
  const words = withoutExt.replace(/[-_]+/g, ' ').trim()
  if (!words) return base
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function subtitle(path: string, language?: string): string {
  const lang = (language ?? path.split('.').pop() ?? 'archivo').toUpperCase()
  if (/\.md$/i.test(path)) return 'Documento · MD'
  return `Código · ${lang}`
}

const TYPE_STYLE: Record<string, { icon: LucideIcon; tile: string; text: string }> = {
  html: { icon: Globe, tile: 'bg-gradient-to-br from-rose-600/80 to-rose-900/70', text: 'text-rose-300' },
  css: { icon: Palette, tile: 'bg-gradient-to-br from-violet-500/70 to-violet-800/60', text: 'text-violet-300' },
  js: { icon: Code2, tile: 'bg-gradient-to-br from-amber-500/70 to-amber-800/60', text: 'text-amber-300' },
  ts: { icon: Code2, tile: 'bg-gradient-to-br from-sky-600/70 to-sky-900/60', text: 'text-sky-300' },
  json: { icon: Braces, tile: 'bg-gradient-to-br from-amber-500/70 to-orange-800/60', text: 'text-amber-200' },
  md: { icon: FileText, tile: 'bg-gradient-to-br from-slate-500/60 to-slate-800/60', text: 'text-slate-300' },
  svg: { icon: ImageIcon, tile: 'bg-gradient-to-br from-emerald-500/70 to-emerald-800/60', text: 'text-emerald-300' },
  text: { icon: FileCode, tile: 'bg-gradient-to-br from-zinc-500/50 to-zinc-800/60', text: 'text-zinc-300' },
}

function typeKey(path: string, language?: string): string {
  const lang = (language ?? path.split('.').pop() ?? 'text').toLowerCase()
  if (lang === 'html') return 'html'
  if (lang === 'css') return 'css'
  if (lang === 'js') return 'js'
  if (lang === 'ts') return 'ts'
  if (lang === 'json') return 'json'
  if (lang === 'md') return 'md'
  if (lang === 'svg') return 'svg'
  return 'text'
}

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== 'number' || bytes <= 0) return null
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`
}

const DEVICE_PRESETS = [
  { id: 'desktop', label: 'Escritorio', icon: Monitor, width: '100%' },
  { id: 'tablet', label: 'Tablet', icon: Tablet, width: '768px' },
  { id: 'mobile', label: 'Móvil', icon: Smartphone, width: '390px' },
] as const

/** Vista previa real del sitio (iframe a los archivos servidos desde la DB). */
function WebFactoryPreviewDialog({
  projectId,
  title,
  open,
  onOpenChange,
}: {
  projectId: string
  title: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [device, setDevice] = useState<(typeof DEVICE_PRESETS)[number]['id']>('desktop')
  const preset = DEVICE_PRESETS.find((d) => d.id === device) ?? DEVICE_PRESETS[0]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92svh] max-w-[96vw] flex-col gap-3 rounded-2xl border-border/70 bg-background p-4 sm:max-w-[1100px]">
        <DialogHeader className="shrink-0 space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Eye className="size-4 text-emerald-300" aria-hidden />
            Vista previa: {title}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Archivos reales servidos desde el proyecto. Navega entre páginas dentro del propio marco.
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 items-center justify-between gap-2">
          <div role="tablist" aria-label="Tamaño de vista" className="flex gap-1 rounded-lg border border-border/60 bg-secondary/40 p-1">
            {DEVICE_PRESETS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="tab"
                aria-selected={device === d.id}
                onClick={() => setDevice(d.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                  device === d.id ? 'bg-emerald-500/15 text-emerald-200' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <d.icon className="size-3.5" aria-hidden />
                {d.label}
              </button>
            ))}
          </div>
          <a
            href={`/api/web-factory/preview/${projectId}/index.html`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-[12px] font-medium text-foreground/85 transition-colors hover:border-emerald-500/40 hover:text-emerald-200"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            Abrir en pestaña
          </a>
        </div>
        <div className="scrollbar-slim flex flex-1 justify-center overflow-auto rounded-xl border border-border/60 bg-secondary/30 p-2">
          <iframe
            key={device}
            src={`/api/web-factory/preview/${projectId}/index.html`}
            title={`Vista previa ${device} de ${title}`}
            style={{ width: preset.width }}
            className="h-full min-h-[420px] rounded-lg border border-border/50 bg-white shadow-xl"
            sandbox="allow-scripts allow-forms"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ProjectFilesBlock({ data }: { data: ProjectFilesData }) {
  const zipUrl = `/api/tools/build-app/${encodeURIComponent(data.id)}/download`
  const changed = useMemo(() => new Set(data.changedPaths ?? []), [data.changedPaths])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const isWeb = data.kind === 'web' || data.mode === 'web'
  const okChecks = (data.checks ?? []).filter((c) => c.status === 'ok').length
  const warnChecks = (data.checks ?? []).filter((c) => c.status === 'revisado').length

  return (
    <div className="my-3 w-full max-w-md" role="region" aria-label={`Archivos de la ${isWeb ? 'web' : 'app'} ${data.title}`}>
      {/* Cabecera discreta con el nombre del proyecto */}
      <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
        <p className="truncate text-[13px] font-semibold tracking-tight text-foreground/90">
          {data.isUpdate ? (isWeb ? 'Sitio actualizado' : 'App actualizada') : isWeb ? 'Sitio construido' : 'App construida'}: {data.title}
        </p>
        {isWeb && (
          <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
            Web Factory
          </span>
        )}
        {isWeb && data.stack && /react|tsx/i.test(data.stack) && (
          <span className="shrink-0 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-300">
            React · TSX
          </span>
        )}
        {data.mode === 'fullstack' && (
          <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
            Full-Stack
          </span>
        )}
        {data.mode === 'frontend' && (
          <span className="shrink-0 rounded-full border border-border/60 bg-secondary/50 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
            Frontend
          </span>
        )}
      </div>

      {data.summary && <p className="mb-2.5 px-0.5 text-xs leading-relaxed text-muted-foreground">{data.summary}</p>}

      {/* Acciones Web Factory: vista previa + validación */}
      {isWeb && data.previewUrl && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2 text-[13px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20"
            aria-label={`Abrir vista previa de ${data.title}`}
          >
            <Eye className="size-4" aria-hidden />
            Vista previa
          </button>
          {data.checks && data.checks.length > 0 && (
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-secondary/50 px-3 py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={detailsOpen}
            >
              <Info className="size-3.5" aria-hidden />
              Validación: {okChecks} ok{warnChecks > 0 ? ` · ${warnChecks} a revisar` : ''}
            </button>
          )}
        </div>
      )}

      {isWeb && detailsOpen && data.checks && (
        <div className="mb-2.5 max-h-56 space-y-1.5 overflow-y-auto scrollbar-slim rounded-xl border border-border/60 bg-secondary/30 p-3" role="region" aria-label="Resultado de la validación automática">
          {data.checks.map((c) => (
            <div key={c.check} className="flex items-start gap-2 text-[11.5px] leading-snug">
              {c.status === 'ok' ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-300" aria-hidden />
              ) : (
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden />
              )}
              <span>
                <span className="font-semibold text-foreground/90">{c.check}</span> — <span className="text-muted-foreground">{c.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {isWeb && data.references && data.references.length > 0 && (
        <p className="mb-2.5 px-0.5 text-[11px] leading-relaxed text-muted-foreground">
          Procedencia: código propio de OE AI · referencias de diseño:{' '}
          {data.references.map((r, i) => (
            <span key={r.repoUrl}>
              {i > 0 && ', '}
              <a href={r.repoUrl} target="_blank" rel="noreferrer" className="text-emerald-300/90 underline decoration-emerald-400/30 hover:decoration-emerald-300">
                {r.name}
              </a>{' '}
              ({r.license})
            </span>
          ))}
        </p>
      )}

      {isWeb && !data.previewUrl && (
        <p className="mb-2.5 px-0.5 text-[11px] leading-relaxed text-muted-foreground">
          Proyecto React/TSX: descárgalo, ejecuta <code className="rounded bg-secondary/60 px-1 py-0.5 text-[10.5px]">npm install</code> y{' '}
          <code className="rounded bg-secondary/60 px-1 py-0.5 text-[10.5px]">npm run dev</code> para verlo en vivo (guía completa en el README).
        </p>
      )}

      {/* Tarjetas de archivos */}
      <ul className="flex flex-col gap-2" aria-label="Archivos del proyecto">
        {data.files.map((f, i) => {
          const key = typeKey(f.path, f.language)
          const style = TYPE_STYLE[key] ?? TYPE_STYLE.text
          const Icon = style.icon
          const isChanged = changed.has(f.path)
          return (
            <motion.li
              key={f.path}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: Math.min(i * 0.05, 0.4) }}
            >
              <div
                className={cn(
                  'flex items-center gap-3 rounded-xl border border-border/60 bg-secondary/40 p-2.5 pr-3 transition-colors hover:border-emerald-500/30 hover:bg-secondary/60',
                )}
              >
                <span
                  className={cn('grid size-11 shrink-0 place-items-center rounded-xl border border-white/10 shadow-inner', style.tile)}
                  aria-hidden
                >
                  <Icon className={cn('size-5', style.text)} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold leading-tight text-foreground/95" title={f.path}>
                    {prettyName(f.path)}
                  </span>
                  <span className="block truncate text-[11px] leading-snug text-muted-foreground">
                    {isChanged ? 'Actualizado · ' : ''}
                    {subtitle(f.path, f.language)}
                    {formatBytes(f.bytes) ? ` · ${formatBytes(f.bytes)}` : ''}
                  </span>
                </span>
                <a
                  href={`${zipUrl}?path=${encodeURIComponent(f.path)}`}
                  download
                  className="shrink-0 rounded-lg border border-border/60 bg-secondary/70 px-3 py-1.5 text-[12px] font-semibold text-foreground/85 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-200"
                  aria-label={`Descargar ${f.path}`}
                >
                  Descargar
                </a>
              </div>
            </motion.li>
          )
        })}
      </ul>

      {/* Descargar todo: la carpeta .zip completa */}
      <a
        href={zipUrl}
        download
        className="mt-2.5 inline-flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/50 px-3.5 py-2 text-[13px] font-semibold text-foreground/90 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-200"
        aria-label={`Descargar todo el ${isWeb ? 'sitio' : 'proyecto'} ${data.title} como ZIP`}
      >
        <Download className="size-4 text-emerald-300" aria-hidden />
        Descargar todo (.zip)
      </a>

      {isWeb && (
        <WebFactoryPreviewDialog projectId={data.id} title={data.title} open={previewOpen} onOpenChange={setPreviewOpen} />
      )}
    </div>
  )
}

/** Tarjeta "En construcción" de una directiva ```oe-build/```oe-web residual (entorno .zip desactivado). */
export function BuildDirectivePending() {
  return (
    <div
      role="status"
      aria-label="Constructor automático en construcción"
      className="my-3 flex w-full max-w-md items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3.5"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-amber-500/30 bg-amber-500/15" aria-hidden>
        <HardHat className="size-[18px] text-amber-300" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold leading-snug text-amber-200">Constructor automático en construcción</span>
        <span className="mt-1 block text-[12px] leading-relaxed text-muted-foreground">
          Mientras el entorno .zip se termina, OE AI entrega el código aquí en el chat: archivo por archivo, con los pasos para abrirlo en VS Code o Cursor.
        </span>
      </span>
    </div>
  )
}
