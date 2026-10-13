'use client'

/**
 * BuildLivePanel — panel del constructor de apps/sitios EN VIVO.
 * Reemplaza al placeholder estático: mientras el pipeline trabaja muestra
 *  - lista de TAREAS que se van marcando (plan → código → empaquetado),
 *  - CÓDIGO de cada archivo en cuanto queda listo (revelado tipo cascada,
 *    resaltado de sintaxis al completar),
 *  - descarga individual por archivo (existente desde el primer archivo),
 *  - botón "Descargar ZIP" al terminar (+ vista previa en sitios web).
 * Estado alimentado por los eventos SSE de /api/tools/build-stream vía el
 * snapshot `BuildLiveSnapshot` que vive dentro del mensaje.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Circle,
  CircleCheck,
  CircleX,
  Download,
  Eye,
  FileCode2,
  Hammer,
  Loader2,
  PackageCheck,
} from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { BuildLiveFile, BuildLiveSnapshot, BuildLiveTodo } from '@/hooks/use-oe-chat'

const LANG_FOR_HIGHLIGHT: Record<string, string> = {
  html: 'markup',
  svg: 'markup',
  css: 'css',
  js: 'javascript',
  json: 'json',
  md: 'markdown',
  ts: 'typescript',
  tsx: 'tsx',
  text: 'markdown',
}

function prettyBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function prettyName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function TodoRow({ todo }: { todo: BuildLiveTodo }) {
  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-start gap-2.5 py-[5px] text-[13px] leading-snug"
    >
      {todo.status === 'done' ? (
        <CircleCheck className="mt-[1px] size-4 shrink-0 text-emerald-400" aria-hidden />
      ) : todo.status === 'active' ? (
        <Loader2 className="mt-[1px] size-4 shrink-0 animate-spin text-emerald-300" aria-hidden />
      ) : todo.status === 'failed' ? (
        <CircleX className="mt-[1px] size-4 shrink-0 text-red-400" aria-hidden />
      ) : (
        <Circle className="mt-[1px] size-4 shrink-0 text-white/25" aria-hidden />
      )}
      <span
        className={
          todo.status === 'done'
            ? 'text-white/55 line-through decoration-white/25'
            : todo.status === 'failed'
              ? 'text-red-300'
              : todo.status === 'active'
                ? 'font-medium text-white'
                : 'text-white/45'
        }
      >
        {todo.label}
      </span>
    </motion.li>
  )
}

function CodeViewer({ files, building }: { files: BuildLiveFile[]; building: boolean }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [revealState, setRevealState] = useState<{ path: string; len: number }>({ path: '', len: 0 })
  const codeRef = useRef<HTMLDivElement>(null)

  // Archivo visible: el seleccionado, o el último que llegó (derivado, sin efectos).
  const activeFile = files.find((f) => f.path === selectedPath) ?? files[files.length - 1] ?? null
  const activeContent = activeFile?.content ?? ''
  const pathKey = activeFile?.path ?? ''
  const revealed = revealState.path === pathKey ? revealState.len : 0
  const isRevealing = activeContent.length > 0 && revealed < activeContent.length

  // Revelado tipo cascada del código (~1 s por archivo, independiente del tamaño).
  // El primer tick ocurre en el intervalo (nunca setState síncrono en el efecto).
  useEffect(() => {
    if (!activeContent) return
    let cancelled = false
    const step = Math.max(48, Math.floor(activeContent.length / 55))
    let current = 0
    const timer = setInterval(() => {
      current += step
      if (current >= activeContent.length) {
        current = activeContent.length
        clearInterval(timer)
      }
      if (!cancelled) setRevealState({ path: pathKey, len: current })
    }, 18)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pathKey, activeContent])

  // Auto-scroll mientras se revela el código.
  useEffect(() => {
    if (isRevealing && codeRef.current) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight
    }
  }, [isRevealing, revealed])

  if (!activeFile) {
    return (
      <div className="flex h-full min-h-44 items-center justify-center rounded-xl border border-white/10 bg-black/30">
        <div className="flex flex-col items-center gap-2 text-xs text-white/40">
          <Loader2 className="size-4 animate-spin text-emerald-300/70" aria-hidden />
          <span>Esperando el primer archivo…</span>
        </div>
      </div>
    )
  }

  const visibleCode = isRevealing ? activeContent.slice(0, revealed) : activeContent
  const highlightLang = LANG_FOR_HIGHLIGHT[activeFile.language] ?? 'markdown'

  return (
    <div className="flex h-full min-h-44 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0a0e14]">
      {/* Chips de archivos: cada uno con su descarga individual desde que existe */}
      <div className="flex flex-wrap gap-1.5 border-b border-white/10 bg-black/30 px-2.5 py-2">
        <AnimatePresence initial={false}>
          {files.map((f) => (
            <motion.span
              key={f.path}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className={`
                inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors
                ${
                  f.path === activeFile.path
                    ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100'
                    : 'border-white/10 bg-white/5 text-white/60 hover:border-white/25 hover:text-white'
                }
              `}
            >
              <button
                type="button"
                onClick={() => setSelectedPath(f.path)}
                className="inline-flex items-center gap-1 font-mono"
                title={`Ver ${f.path}`}
              >
                <FileCode2 className="size-3" aria-hidden />
                {prettyName(f.path)}
              </button>
              {f.url && (
                <a
                  href={f.url}
                  download
                  onClick={(e) => e.stopPropagation()}
                  className="rounded p-0.5 text-white/50 transition-colors hover:bg-white/10 hover:text-emerald-200"
                  title={`Descargar ${prettyName(f.path)} (${prettyBytes(f.bytes)})`}
                  aria-label={`Descargar ${f.path}`}
                >
                  <Download className="size-3" aria-hidden />
                </a>
              )}
            </motion.span>
          ))}
        </AnimatePresence>
      </div>

      {/* Cabecera del archivo activo */}
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-1.5 text-[11px] text-white/40">
        <span className="truncate font-mono" title={activeFile.path}>
          {activeFile.path}
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          {prettyBytes(activeFile.bytes)} · {activeFile.language}
          {isRevealing ? ' · escribiendo…' : ''}
        </span>
      </div>

      {/* Código: mono plano durante la cascada, resaltado al completar */}
      <div ref={codeRef} className="oe-scroll-slim min-h-0 flex-1 overflow-auto">
        {isRevealing ? (
          <pre className="whitespace-pre px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-emerald-100/85">
            {visibleCode}
            <span className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-emerald-300 align-middle" aria-hidden />
          </pre>
        ) : (
          <SyntaxHighlighter
            language={highlightLang}
            style={oneDark}
            customStyle={{ margin: 0, background: 'transparent', fontSize: '11.5px', lineHeight: 1.55, padding: '10px 12px' }}
            codeTagProps={{ style: { fontFamily: 'var(--font-geist-mono, ui-monospace, monospace)' } }}
            wrapLongLines={false}
          >
            {activeContent}
          </SyntaxHighlighter>
        )}
      </div>

      {building && (
        <div className="border-t border-white/10 px-3 py-1.5 text-[11px] text-white/45">
          {files.length} archivo{files.length === 1 ? '' : 's'} listo{files.length === 1 ? '' : 's'} — puedes descargar cada
          uno en cuanto aparece
        </div>
      )}
    </div>
  )
}

export function BuildLivePanel({ build }: { build: BuildLiveSnapshot }) {
  const [seconds, setSeconds] = useState(0)
  const building = build.status === 'building'

  useEffect(() => {
    if (!building) return
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [building])

  const doneCount = build.todos.filter((t) => t.status === 'done').length
  const totalBytes = build.files.reduce((acc, f) => acc + (f.bytes || 0), 0)

  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-[#0b1016] text-white shadow-xl">
      {/* Cabecera: título del proyecto + estado/tiempo */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/30 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`grid size-8 shrink-0 place-items-center rounded-xl border ${
              build.status === 'ready'
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                : build.status === 'error'
                  ? 'border-red-400/40 bg-red-400/10 text-red-300'
                  : 'border-white/15 bg-white/5 text-emerald-200'
            }`}
          >
            {build.status === 'ready' ? (
              <PackageCheck className="size-4" aria-hidden />
            ) : build.status === 'error' ? (
              <CircleX className="size-4" aria-hidden />
            ) : (
              <Hammer className="size-4" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" title={build.title ?? undefined}>
              {build.title || (build.kind === 'web' ? 'Nuevo sitio web' : 'Nueva app')}
              {build.isUpdate ? ' · actualización' : ''}
            </p>
            <p className="truncate text-[11px] text-white/45">
              {building
                ? (build.note ?? 'Construyendo en el servidor…')
                : build.status === 'error'
                  ? (build.error ?? 'La construcción falló.')
                  : (build.summary || `${build.files.length} archivos generados`)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-white/50">
          {building ? (
            <>
              <Loader2 className="size-3.5 animate-spin text-emerald-300" aria-hidden />
              <span className="font-mono tabular-nums">{seconds} s</span>
            </>
          ) : build.status === 'ready' ? (
            <>
              <CircleCheck className="size-3.5 text-emerald-400" aria-hidden />
              <span className="font-mono tabular-nums">
                {build.latencyMs ? `${Math.round(build.latencyMs / 1000)} s` : `${doneCount}/${build.todos.length}`}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="grid gap-0 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        {/* Tareas (estilo lista de todos con cuenta) */}
        <div className="border-b border-white/10 px-4 py-3 md:border-b-0 md:border-r">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-white/50">Tareas</span>
            {build.todos.length > 0 && (
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white/60">
                {doneCount}/{build.todos.length}
              </span>
            )}
          </div>
          <ul>
            <AnimatePresence initial={false}>
              {build.todos.map((t) => (
                <TodoRow key={t.id} todo={t} />
              ))}
            </AnimatePresence>
          </ul>
        </div>

        {/* Código en vivo */}
        <div className="min-h-0 p-3">
          <CodeViewer files={build.files} building={building} />
        </div>
      </div>

      {/* Pie: descargas */}
      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-black/30 px-4 py-3">
        {building ? (
          <p className="flex items-center gap-2 text-xs text-white/45">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />
            Generando archivos reales — nada simulado. Al terminar podrás descargar el ZIP completo.
          </p>
        ) : build.status === 'ready' ? (
          <>
            <a
              href={build.zipUrl ?? '#'}
              download
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-400"
            >
              <Download className="size-4" aria-hidden />
              Descargar ZIP
            </a>
            {build.previewUrl && (
              <a
                href={build.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3.5 py-2 text-sm font-medium text-white/85 transition-colors hover:border-white/30 hover:text-white"
              >
                <Eye className="size-4" aria-hidden />
                Vista previa
              </a>
            )}
            <span className="ml-auto text-[11px] tabular-nums text-white/45">
              {build.files.length} archivo{build.files.length === 1 ? '' : 's'} · {prettyBytes(totalBytes)}
            </span>
          </>
        ) : (
          <p className="flex items-center gap-2 text-xs text-red-300">
            <CircleX className="size-3.5" aria-hidden />
            {build.error ?? 'La construcción falló. Pide que lo intente de nuevo.'}
          </p>
        )}
      </div>
    </div>
  )
}
