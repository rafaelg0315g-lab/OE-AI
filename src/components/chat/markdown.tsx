'use client'

/**
 * Render de markdown para respuestas de OE AI LLM.
 * Estilo premium oscuro: encabezados, listas, tablas (GFM), citas y bloques de
 * código con resaltado de sintaxis y botón de copia.
 *
 * Normalización previa (consciente de vallas de código):
 * - `<br>` y variantes escapadas (`\<br>`, `&lt;br&gt;`) → salto de línea real.
 * - Secuencias literales `\n` / `\r\n` → salto de línea real.
 * Los bloques de código (``` ``` ) NUNCA se transforman: sus backslashes y
 * secuencias se conservan intactos.
 * Seguridad: react-markdown NO renderiza HTML crudo (sin rehype-raw) y sanea
 * las URLs de los enlaces; no se ejecuta JavaScript del modelo.
 */
import { memo, useState } from 'react'
import { Check, Copy, MonitorPlay } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { cn } from '@/lib/utils'
import { BuildDirectivePending, ProjectFilesBlock, parseProjectFiles } from './project-files'

/** Transforma SOLO los segmentos fuera de vallas de código. */
function normalizeDisplayMarkdown(src: string): string {
  const chunks = src.split('```')
  return chunks
    .map((chunk, i) => {
      if (i % 2 === 0) return normalizeTextSegment(chunk)
      return chunk // segmento de código: intacto
    })
    .join('```')
}

/** Saltos de línea reales a partir de <br>, variantes escapadas y \n literales. */
function normalizeTextSegment(text: string): string {
  return (
    text
      // <br>, <br/>, \<br>, &lt;br&gt; (con o sin barra) → newline real
      .replace(/(?:\\)?(?:&lt;|<)br\s*\/?\s*(?:&gt;|\\>|>)/gi, '\n')
      // \r\n y \n literales (dos caracteres) → newline real
      .replace(/\\r\\n|\\n/g, '\n')
  )
}

function CodeBlock({
  code,
  lang,
  onOpenCanvas,
}: {
  code: string
  lang?: string
  /** Presente solo en bloques html de mensajes del asistente: abre el Canvas. */
  onOpenCanvas?: () => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-xl border border-border/70 bg-[oklch(0.145_0.008_260)]">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {lang || 'código'}
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
            })
          }}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Copiar código"
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
        {onOpenCanvas && (
          <button
            type="button"
            onClick={onOpenCanvas}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Abrir vista previa del bloque HTML en Canvas"
            title="Abrir en Canvas"
          >
            <MonitorPlay className="size-3" aria-hidden />
            Canvas
          </button>
        )}
      </div>
      <div className="scrollbar-slim max-w-full overflow-x-auto text-[13px] leading-relaxed">
        <SyntaxHighlighter
          language={lang || 'text'}
          style={oneDark}
          wrapLongLines={false}
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: '14px 16px',
            background: 'transparent',
            fontSize: 13,
            lineHeight: 1.6,
          }}
          codeTagProps={{ style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  )
}

export const Markdown = memo(function Markdown({
  content,
  className,
  onOpenCanvas,
}: {
  content: string
  className?: string
  /** Si llega, los bloques ```html muestran el botón Canvas (solo asistente). */
  onOpenCanvas?: (code: string) => void
}) {
  return (
    <div className={cn('text-sm leading-relaxed break-words', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="mt-4 mb-2 text-lg font-semibold tracking-tight first:mt-0" {...p} />,
          h2: (p) => <h2 className="mt-4 mb-2 text-base font-semibold tracking-tight first:mt-0" {...p} />,
          h3: (p) => <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0" {...p} />,
          p: (p) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5 last:mb-0" {...p} />,
          ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5 last:mb-0" {...p} />,
          li: (p) => <li className="leading-relaxed" {...p} />,
          a: (p) => (
            <a
              className="font-medium text-emerald-300 underline decoration-emerald-400/40 underline-offset-2 hover:decoration-emerald-300"
              target="_blank"
              rel="noreferrer"
              {...p}
            />
          ),
          // Video generado por IA (contrato 19-e): un nodo de imagen con URL
          // terminada en .mp4 o con la pista `#video` se renderiza como <video>.
          img: ({ node, src, alt, ...rest }) => {
            const url = typeof src === 'string' ? src : ''
            if (url.endsWith('.mp4') || url.endsWith('#video')) {
              const clean = url.endsWith('#video') ? url.slice(0, -'#video'.length) : url
              return <video src={clean} controls preload="metadata" className="my-2 max-w-full rounded-lg" />
            }
            return <img src={url} alt={alt ?? ''} {...rest} className="my-2 max-w-full rounded-lg" />
          },
          blockquote: (p) => (
            <blockquote className="my-2 border-l-2 border-emerald-500/40 pl-3 text-muted-foreground" {...p} />
          ),
          hr: () => <hr className="my-3 border-border/60" />,
          table: (p) => (
            <div className="scrollbar-slim oe-md-table-wrap my-3 max-w-full overflow-x-auto rounded-lg border border-border/70">
              <table className="oe-md-table" {...p} />
            </div>
          ),
          thead: (p) => <thead className="oe-md-table-head" {...p} />,
          th: (p) => <th className="oe-md-table-th" {...p} />,
          td: (p) => <td className="oe-md-table-td" {...p} />,
          code: ({ className: cls, children, ...rest }) => {
            const text = String(children ?? '').replace(/\n$/, '')
            const isBlock = /language-/.test(cls ?? '') || text.includes('\n')
            if (isBlock) {
              const lang = /language-([\w-]+)/.exec(cls ?? '')?.[1]
              // Constructor de apps: bloque oeproject → tarjetas de archivos
              // (Claude style), bloque oe-build aún sin resolver → estado.
              if (lang === 'oeproject') {
                const data = parseProjectFiles(text)
                return data ? <ProjectFilesBlock data={data} /> : <BuildDirectivePending />
              }
              if (lang === 'oe-build' || lang === 'oe-web') return <BuildDirectivePending />
              const isHtml = (lang ?? '').toLowerCase() === 'html'
              return <CodeBlock code={text} lang={lang} onOpenCanvas={isHtml && onOpenCanvas ? () => onOpenCanvas(text) : undefined} />
            }
            return (
              <code
                className="rounded-md border border-border/50 bg-secondary/70 px-1.5 py-0.5 font-mono text-[12px]"
                {...rest}
              >
                {children}
              </code>
            )
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {normalizeDisplayMarkdown(content)}
      </ReactMarkdown>
    </div>
  )
})
