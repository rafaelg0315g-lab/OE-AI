'use client'

/**
 * Render de markdown para respuestas de OE AI LLM.
 * Estilo premium oscuro: encabezados, listas, tablas (GFM), citas y bloques de
 * código con resaltado de sintaxis y botón de copia.
 *
 * FORMATO RICO (respuestas interactivas estilo GPT):
 * - Bloques :::cards … ::: → tarjetas con icono, título y descripción
 *   (sintaxis: `- icono | Título | Descripción`, icono = nombre lucide).
 * - Bloques :::plan … ::: → plan/timeline con pasos numerados y conector.
 * - Bloques :::gallery … ::: → canvas con imágenes REALES de la web:
 *   `- Título | Descripción | consulta en inglés`; cada fila busca en
 *   /api/tools/image-search (resultados re-hosteados, estables) y muestra
 *   la foto con esqueleto de carga y respaldo si la búsqueda falla.
 * - Bloques :::svg … ::: → tarjeta con vista previa del SVG y descarga
 *   en .svg o .png (rasterizado local en canvas).
 * Los bloques se renderizan incluso a mitad del streaming (filas parciales),
 * y el texto normal conserva todo el tratamiento markdown previo.
 *
 * Normalización previa (consciente de vallas de código):
 * - `<br>` y variantes escapadas (`\<br>`, `&lt;br&gt;`) → salto de línea real.
 * - Secuencias literales `\n` / `\r\n` → salto de línea real.
 * Los bloques de código (``` ``` ) NUNCA se transforman: sus backslashes y
 * secuencias se conservan intactos.
 * Seguridad: react-markdown NO renderiza HTML crudo (sin rehype-raw); el SVG
 * se inyecta SOLO como `src` de <img> (data URL), nunca como DOM crudo, por lo
 * que los scripts embebidos en el SVG no se ejecutan.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import {
  Activity, Award, Bot, Box, Briefcase, Bug, Building, Calendar, Camera, Car, Check, Clock, Cloud,
  Code, Compass, Copy, CreditCard, Cpu, Database, DollarSign, Download, Eye, FileText, Flame, Flag,
  Folder, Gamepad2, Gift, Globe, GraduationCap, Headphones, Heart, HeartPulse, Home, Brain, Image as ImageIcon,
  Key, Layers, Leaf, Lightbulb, Link as LinkIcon, Lock, Mail, Map as MapIcon, Mic, MonitorPlay, Moon,
  MessageCircle, Music, Package, Palette, Phone, Plane, Play, Rocket, Scale, Search, Server, Settings,
  Shield, ShoppingCart, Sparkles, Star, Sun, Target, Terminal, TrendingUp, Truck, Users, Video, Wifi,
  Wrench, Zap,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { cn } from '@/lib/utils'
import { BuildDirectivePending, ProjectFilesBlock, parseProjectFiles } from './project-files'

/** Mapa de iconos permitidos para las tarjetas (nombre → componente lucide). */
const CARD_ICONS: Record<string, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>> = {
  zap: Zap, mic: Mic, eye: Eye, shield: Shield, database: Database, cpu: Cpu, globe: Globe,
  image: ImageIcon, code: Code, rocket: Rocket, settings: Settings, users: Users, lock: Lock,
  brain: Brain, sparkles: Sparkles, wrench: Wrench, cloud: Cloud, phone: Phone, mail: Mail,
  clock: Clock, check: Check, book: Lightbulb, search: Search, bot: Bot, palette: Palette,
  video: Video, music: Music, folder: Folder, key: Key, server: Server, layers: Layers, box: Box,
  star: Star, heart: Heart, flag: Flag, compass: Compass, camera: Camera, terminal: Terminal,
  bug: Bug, package: Package, 'credit-card': CreditCard, 'trending-up': TrendingUp, target: Target,
  award: Award, briefcase: Briefcase, building: Building, home: Home, leaf: Leaf, sun: Sun,
  moon: Moon, flame: Flame, link: LinkIcon, map: MapIcon, gift: Gift, wifi: Wifi, activity: Activity,
  dollar: DollarSign, message: MessageCircle, play: Play, file: FileText, calendar: Calendar,
  cart: ShoppingCart, truck: Truck, headphones: Headphones, gamepad: Gamepad2, plane: Plane,
  car: Car, graduation: GraduationCap, pulse: HeartPulse, scale: Scale, lightbulb: Lightbulb,
  // Alias frecuentes que los modelos usan pese a la lista cerrada:
  growth: TrendingUp, analytics: TrendingUp, money: DollarSign, finance: DollarSign,
  team: Users, time: Clock, audit: Search, plan: Target, idea: Lightbulb, ai: Brain,
  data: Database, security: Shield, speed: Zap, chat: MessageCircle, support: MessageCircle,
}

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

/* ── Formato rico: segmentación de bloques :::cards / :::svg ─────────────── */

type RichSegment =
  | { type: 'md'; text: string }
  | { type: 'cards'; text: string; closed: boolean }
  | { type: 'plan'; text: string; closed: boolean }
  | { type: 'gallery'; text: string; closed: boolean }
  | { type: 'svg'; text: string; closed: boolean }
  | { type: 'oe-directive'; text: string; closed: boolean }

/**
 * Divide el contenido en segmentos markdown y bloques ricos. Las vallas de
 * código (``` ``` ) tienen prioridad: dentro de ellas NO hay bloques :::.
 * Un bloque sin cerrar (streaming) se entrega como parcial para renderizado
 * progresivo.
 */
function splitRichSegments(src: string): RichSegment[] {
  const segments: RichSegment[] = []
  const fenceChunks = src.split('```')
  fenceChunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      // Valla de código completa: markdown intacto (reunir la valla).
      segments.push({ type: 'md', text: '```' + chunk })
      return
    }
    // Segmento de texto: localizar bloques :::cards / :::plan / :::gallery / :::svg
    // y también :::oe-build / :::oe-web (variante errónea de la directiva de
    // construcción: se muestra como estado "construyendo", nunca JSON crudo).
    let rest = chunk
    while (true) {
      const open = /[ \t]*:::(cards|svg|plan|gallery|oe-build|oe-web)\b[^\n]*\n?/.exec(rest)
      if (!open) {
        if (rest) segments.push({ type: 'md', text: rest })
        break
      }
      if (open.index > 0) segments.push({ type: 'md', text: rest.slice(0, open.index) })
      const label = open[1]
      if (label === 'oe-build' || label === 'oe-web') {
        // Directiva con ::: (variante de modelo): el contenido real (JSON) lo
        // procesa extractBuildDirective sobre el texto completo; aquí solo se
        // oculta el bloque y se muestra el estado de construcción.
        const after = rest.slice(open.index + open[0].length)
        const closeIdx = after.search(/^[ \t]*:::[ \t]*$/m)
        segments.push({ type: 'oe-directive', text: closeIdx === -1 ? after : after.slice(0, closeIdx), closed: closeIdx !== -1 })
        rest = closeIdx === -1 ? '' : after.slice(closeIdx).replace(/^[ \t]*:::[ \t]*\n?/, '')
        continue
      }
      const kind = (label === 'svg' ? 'svg' : label) as Exclude<RichSegment, { type: 'md' } | { type: 'oe-directive' }>['type']
      const after = rest.slice(open.index + open[0].length)
      const closeIdx = after.search(/^[ \t]*:::[ \t]*$/m)
      if (closeIdx === -1) {
        // Sin cierre (streaming o respuesta truncada): se descarta un cierre
        // parcial en la última línea ("::" o ":::") para no crear tarjetas basura.
        segments.push({ type: kind, text: after.replace(/\n[ \t]*:{2,3}[ \t]*$/, ''), closed: false })
        rest = ''
        break
      }
      segments.push({ type: kind, text: after.slice(0, closeIdx), closed: true })
      rest = after.slice(closeIdx).replace(/^[ \t]*:::[ \t]*\n?/, '')
    }
  })
  return segments
}

/* ── Tarjetas con icono (estilo GPT) ────────────────────────────────────── */

interface CardItem {
  icon: string
  title: string
  desc: string
}

/** Parser tolerante de filas `- icono | Título | Descripción`. */
function parseCards(text: string): CardItem[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s*/, ''))
    .map((line) => {
      const parts = line.split('|').map((p) => p.trim())
      if (parts.length >= 3) return { icon: parts[0].toLowerCase(), title: parts[1], desc: parts.slice(2).join(' · ') }
      if (parts.length === 2) return { icon: parts[0].toLowerCase(), title: parts[1], desc: '' }
      return { icon: '', title: parts[0] ?? '', desc: '' }
    })
    .filter((c) => c.title.length > 0 && !/^[.:;\s—-]*$/.test(c.title))
}

function CardGroup({ items }: { items: CardItem[] }) {
  return (
    <div className="oe-md-cards my-3 overflow-hidden rounded-2xl border border-border/70 bg-card/30">
      <div className="divide-y divide-border/50">
        {items.map((card, i) => {
          const Icon = card.icon ? CARD_ICONS[card.icon] : undefined
          return (
            <div key={`${i}-${card.title}`} className="flex items-start gap-3 p-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-secondary/60">
                {Icon ? (
                  <Icon className="size-4 text-emerald-300" aria-hidden />
                ) : (
                  <Sparkles className="size-4 text-emerald-300" aria-hidden />
                )}
              </span>
              <div className="min-w-0">
                <p className="oe-display text-sm font-medium leading-snug">{card.title}</p>
                {card.desc && <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{card.desc}</p>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Plan con timeline (pasos numerados y conector vertical) ────────────── */

interface PlanStep {
  title: string
  desc: string
}

/** Parser tolerante de filas `- Título | Descripción`. */
function parsePlanRows(text: string): PlanStep[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s*/, ''))
    .map((line) => {
      const parts = line.split('|').map((p) => p.trim())
      if (parts.length >= 2) return { title: parts[0], desc: parts.slice(1).join(' · ') }
      return { title: parts[0] ?? '', desc: '' }
    })
    .filter((s) => s.title.length > 0 && !/^[.:;\s—-]*$/.test(s.title))
    .slice(0, 8)
}

function PlanBlock({ steps }: { steps: PlanStep[] }) {
  return (
    <div className="oe-md-plan my-3 overflow-hidden rounded-2xl border border-border/70 bg-card/30">
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2.5">
        <Target className="size-3.5 text-emerald-300" aria-hidden />
        <span className="oe-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Plan
        </span>
      </div>
      <ol className="px-4 py-3.5">
        {steps.map((step, i) => (
          <li key={`${i}-${step.title}`} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && (
              <span className="absolute bottom-0 left-[13px] top-8 w-px bg-gradient-to-b from-emerald-400/35 to-border/50" aria-hidden />
            )}
            <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-[12px] font-semibold text-emerald-300">
              {i + 1}
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="oe-display text-sm font-medium leading-snug">{step.title}</p>
              {step.desc && <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{step.desc}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ── Galería con imágenes reales de la web (canvas visual) ──────────────── */

interface GalleryItem {
  title: string
  desc: string
  query: string
}

/**
 * Parser de filas `- Título | Descripción | consulta en inglés`.
 * Tolerante: 2 campos → título + consulta. Las filas cuya "consulta" es una
 * URL se descartan (las imágenes SIEMPRE las busca la plataforma, nunca URLs
 * elegidas por el modelo).
 */
function parseGalleryRows(text: string): GalleryItem[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s*/, ''))
    .map((line) => {
      const parts = line.split('|').map((p) => p.trim())
      if (parts.length >= 3) return { title: parts[0], desc: parts.slice(1, -1).join(' · '), query: parts[parts.length - 1] }
      if (parts.length === 2) return { title: parts[0], desc: '', query: parts[1] }
      return { title: parts[0] ?? '', desc: '', query: '' }
    })
    .filter((g) => g.title.length > 0 && g.query.length > 1 && !/^https?:\/\//i.test(g.query))
    .slice(0, 6)
}

type GalleryHitState = { status: 'loading' } | { status: 'ok'; url: string } | { status: 'error' }

function GalleryRow({ item, index }: { item: GalleryItem; index: number }) {
  const [hit, setHit] = useState<GalleryHitState>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    // Debounce: durante la cascada del streaming la consulta crece carácter a
    // carácter; solo buscamos cuando la fila lleva 700 ms sin cambiar (fila
    // completa) para no disparar una petición por cada letra ni quemar el
    // límite de peticiones del endpoint.
    const timer = window.setTimeout(() => {
      if (item.query.trim().length < 4) {
        setHit({ status: 'error' })
        return
      }
      fetch(`/api/tools/image-search?q=${encodeURIComponent(item.query)}&count=1`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
        .then((data: { results?: Array<{ url?: string }> }) => {
          if (!alive) return
          const url = data.results?.[0]?.url
          setHit(url ? { status: 'ok', url } : { status: 'error' })
        })
        .catch(() => {
          if (alive) setHit({ status: 'error' })
        })
    }, 700)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [item.query])

  return (
    <div className="flex items-start gap-3.5 p-4">
      <div className="oe-gallery-tile relative size-20 shrink-0 overflow-hidden rounded-xl border border-border/50 bg-secondary/40 sm:size-24">
        {hit.status === 'loading' && <div className="absolute inset-0 animate-pulse bg-secondary/70" aria-hidden />}
        {hit.status === 'ok' && (
          <img
            src={hit.url}
            alt={item.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-full object-cover transition-transform duration-500 hover:scale-[1.04]"
          />
        )}
        {hit.status === 'error' && (
          <div className="flex size-full items-center justify-center text-muted-foreground/60">
            <ImageIcon className="size-5" aria-hidden />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="oe-display text-sm font-medium leading-snug">
          <span className="mr-1.5 text-muted-foreground/80">{index + 1}.</span>
          {item.title}
        </p>
        {item.desc && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{item.desc}</p>}
      </div>
    </div>
  )
}

function GalleryBlock({ items }: { items: GalleryItem[] }) {
  return (
    <div className="oe-md-gallery my-3 overflow-hidden rounded-2xl border border-border/70 bg-card/30">
      <div className="divide-y divide-border/50">
        {items.map((item, i) => (
          <GalleryRow key={`${i}-${item.query}`} item={item} index={i} />
        ))}
      </div>
    </div>
  )
}

/* ── Tarjeta SVG: vista previa + descarga .svg/.png ─────────────────────── */

function SvgCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  // Vista previa como data URL en <img>: el SVG nunca se inyecta como DOM crudo.
  const dataUrl = useMemo(() => `data:image/svg+xml;utf8,${encodeURIComponent(code)}`, [code])

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  const downloadSvg = () => {
    triggerDownload(new Blob([code], { type: 'image/svg+xml' }), 'oe-ai-vector.svg')
  }

  const downloadPng = () => {
    // Rasterizado local (canvas): 512x512, fondo transparente. Se fuerza
    // width/height porque algunos navegadores no rasterizan SVG solo-viewBox.
    const sized = /<svg[^>]*\swidth=/i.test(code) ? code : code.replace(/<svg/i, '<svg width="512" height="512"')
    const blob = new Blob([sized], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const img = document.createElement('img')
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 512
        canvas.height = 512
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('sin canvas')
        ctx.drawImage(img, 0, 0, 512, 512)
        canvas.toBlob((png) => {
          if (png) triggerDownload(png, 'oe-ai-icono.png')
        }, 'image/png')
      } catch {
        setFailed(true)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      setFailed(true)
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  return (
    <div className="oe-md-svg my-3 overflow-hidden rounded-2xl border border-border/70 bg-[oklch(0.145_0.008_260)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">svg · vectorial</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={downloadPng}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Descargar como PNG (512x512)"
            title="Descargar PNG"
          >
            <ImageIcon className="size-3" aria-hidden />
            PNG
          </button>
          <button
            type="button"
            onClick={downloadSvg}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Descargar archivo SVG"
            title="Descargar SVG"
          >
            <Download className="size-3" aria-hidden />
            SVG
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1600)
              })
            }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Copiar código SVG"
          >
            {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      </div>
      <div className="flex items-center justify-center bg-white p-4">
        {failed ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            La vista previa del SVG no está disponible; el código sigue siendo descargable.
          </p>
        ) : (
          <img
            src={dataUrl}
            alt="Gráfico vectorial SVG generado por OE AI LLM"
            className="max-h-64 w-auto max-w-full"
            loading="lazy"
          />
        )}
      </div>
    </div>
  )
}

/* ── Segmento markdown normal (comportamiento previo, intacto) ──────────── */

/** Clases de prosa serif (variante asistente, estilo Claude). */
function proseCls(serif: boolean | undefined, extra?: string): string {
  return cn(extra, serif && 'oe-serif-text')
}

function MarkdownSegment({
  text,
  onOpenCanvas,
  serif,
}: {
  text: string
  onOpenCanvas?: (code: string) => void
  /** true: prosa del asistente en serif editorial (estilo Claude). */
  serif?: boolean
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: (p) => <h1 className={proseCls(serif, 'oe-display mt-4 mb-2 text-lg font-semibold tracking-tight first:mt-0')} {...p} />,
        h2: (p) => <h2 className={proseCls(serif, 'oe-display mt-4 mb-2 text-base font-semibold tracking-tight first:mt-0')} {...p} />,
        h3: (p) => <h3 className={proseCls(serif, 'oe-display mt-3 mb-1.5 text-sm font-semibold first:mt-0')} {...p} />,
        p: (p) => <p className={proseCls(serif, 'my-2 first:mt-0 last:mb-0')} {...p} />,
        ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5 last:mb-0" {...p} />,
        ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5 last:mb-0" {...p} />,
        li: (p) => <li className={proseCls(serif, 'leading-relaxed')} {...p} />,
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
          <blockquote
            className={proseCls(serif, 'my-2 border-l-2 border-emerald-500/40 pl-3 text-muted-foreground')}
            {...p}
          />
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
      {normalizeDisplayMarkdown(text)}
    </ReactMarkdown>
  )
}

export const Markdown = memo(function Markdown({
  content,
  className,
  onOpenCanvas,
  serif,
}: {
  content: string
  className?: string
  /** Si llega, los bloques ```html muestran el botón Canvas (solo asistente). */
  onOpenCanvas?: (code: string) => void
  /** true: prosa del asistente en serif editorial (estilo Claude). */
  serif?: boolean
}) {
  const segments = useMemo(() => splitRichSegments(content), [content])
  return (
    <div className={cn('text-sm leading-relaxed break-words', className)}>
      {segments.map((seg, i) => {
        if (seg.type === 'cards') {
          const items = parseCards(seg.text)
          return items.length > 0 ? <CardGroup key={i} items={items} /> : null
        }
        if (seg.type === 'plan') {
          const steps = parsePlanRows(seg.text)
          return steps.length > 0 ? <PlanBlock key={i} steps={steps} /> : null
        }
        if (seg.type === 'gallery') {
          const items = parseGalleryRows(seg.text)
          return items.length > 0 ? <GalleryBlock key={i} items={items} /> : null
        }
        if (seg.type === 'svg') {
          const trimmed = seg.text.trim()
          if (!trimmed) return null
          // A mitad del streaming: el código se muestra como bloque de código
          // y, al completarse el bloque, salta a la tarjeta con vista previa.
          if (!seg.closed) return <CodeBlock key={i} code={trimmed} lang="svg" />
          return <SvgCard key={i} code={trimmed} />
        }
        if (seg.type === 'oe-directive') {
          // Directiva :::oe-build/:::oe-web: el flujo real de construcción lo
          // dispara el hook sobre el texto completo; aquí solo se ve el estado.
          return <BuildDirectivePending key={i} />
        }
        return <MarkdownSegment key={i} text={seg.text} onOpenCanvas={onOpenCanvas} serif={serif} />
      })}
    </div>
  )
})
