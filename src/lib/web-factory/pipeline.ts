/**
 * OE AI Web Factory — Pipeline de composición y generación (servidor únicamente).
 *
 * Dos modos de salida (elige el planificador según la petición):
 *  - "html": sitio estático multi-página (HTML + CSS + JS vanilla), sin dependencias.
 *  - "react": proyecto React 18 + TypeScript + Vite con componentes .tsx reales
 *    (scaffold determinista + componentes LLM), para cuando el usuario pide
 *    React/TSX/Next/SPA explícitamente.
 *
 * Flujo por solicitud:
 *   1. Plan CONTRATO con referencias del catálogo (HyperUI + HugoBlox Kit + GitHub):
 *      tipo de sitio, estética, framework, sistema de diseño (paleta/tipografía/
 *      radios/motion), páginas y secciones coherentes, interacciones e imágenes.
 *   2. Shell compartido (una llamada): styles.css con variables del sistema de
 *      diseño + clases .wf-* premium + app.js (HTML) o components/site.tsx (React).
 *   3. Páginas en PARALELO (máx 4, arranque escalonado y 1 reintento): cada una
 *      usa SOLAMENTE el shell .wf-* (coherencia de un único producto).
 *   4. Imágenes: hasta 2 generadas con el proveedor configurado (best-effort);
 *      las que fallan quedan como degradado elegante, sin enlaces rotos.
 *   5. Validación estática honesta (validate.ts) + README determinista con
 *      procedencia, licencias y cómo ejecutar.
 *   6. Persistencia en BuildProject/BuildFile → descargable (ZIP) y, en modo
 *      html, vista previa real vía /api/web-factory/preview/[id]/.
 *
 * Modificación: "update" reescribe SOLO los archivos afectados con el contexto
 * del proyecto existente.
 *
 * Reutilización responsable: el código SIEMPRE es propio (lo escribe el modelo
 * a partir de patrones del catálogo); los repos son referencia visual y su
 * licencia queda registrada en la procedencia del proyecto.
 */
import { buildChatJson } from '@/lib/build/llm'
import { db } from '@/lib/db'
import { guessCategory, listComponentKinds, pickReferences, type CatalogTemplate } from './catalog'
import { validateSite, type FactoryCheck } from './validate'
import { languageFromPath } from '@/lib/build/types'

export class WebFactoryError extends Error {
  errorType: 'rate_limited' | 'empty_response' | 'json_parse' | 'provider_error' | 'invalid_plan' | 'no_files' | 'aborted'
  constructor(message: string, errorType: WebFactoryError['errorType']) {
    super(message)
    this.errorType = errorType
  }
}

const MAX_PAGES = 4
const MAX_FILES = 22

export type SiteFramework = 'html' | 'react'

interface DesignSystem {
  paletteName?: unknown
  bg?: unknown
  surface?: unknown
  text?: unknown
  muted?: unknown
  primary?: unknown
  accent?: unknown
  radius?: unknown
  shadow?: unknown
  headingFont?: unknown
  bodyFont?: unknown
  motion?: unknown
}

interface RawPlan {
  title?: unknown
  summary?: unknown
  siteType?: unknown
  aesthetic?: unknown
  framework?: unknown
  designSystem?: DesignSystem
  pages?: unknown
  interactions?: unknown
  images?: unknown
  references?: unknown
}

export interface FactoryPage {
  path: string
  title: string
  sections: string[]
}

export interface FactoryPlan {
  title: string
  summary: string
  siteType: string
  aesthetic: string
  framework: SiteFramework
  designSystem: Record<string, string>
  pages: FactoryPage[]
  interactions: string[]
  images: Array<{ slot: string; prompt: string; size: string }>
  references: Array<{ name: string; repoUrl: string; license: string; usage: string }>
}

export interface FactoryResult {
  id: string
  title: string
  summary: string
  mode: 'web'
  framework: SiteFramework
  stack: string
  isUpdate: boolean
  changedPaths: string[]
  files: Array<{ path: string; language: string; bytes: number }>
  designSystem: Record<string, string>
  references: FactoryPlan['references']
  checks: FactoryCheck[]
  warnings: string[]
  images: Array<{ slot: string; assetId: string; url: string }>
  previewUrl: string
  latencyMs: number
}

function s(v: unknown, fallback: string, max = 120): string {
  const str = typeof v === 'string' && v.trim() ? v.trim() : fallback
  return str.slice(0, max)
}

function sanitizePagePath(raw: unknown): string | null {
  const p = s(raw, '', 60).toLowerCase().replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!p || !/^[\w-]+\.html$/.test(p) || p.includes('..')) return null
  return p
}

/** Rutas válidas para proyectos React: solo archivos propios dentro de src/. */
function sanitizeReactPath(raw: unknown): string | null {
  const p = s(raw, '', 80).replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!p || p.includes('..')) return null
  return /^src\/[\w/.-]+\.(tsx|ts|css)$/.test(p) ? p : null
}

/** Convierte "servicios.html" → módulo de página React: Servicios.tsx + ruta /servicios. */
function pageModule(page: FactoryPage): { route: string; name: string; file: string; title: string } {
  const base = page.path.replace(/\.html$/, '')
  if (base === 'index') return { route: '/', name: 'Home', file: 'src/pages/Home.tsx', title: 'Inicio' }
  const pascal = base
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
  return { route: `/${base}`, name: pascal, file: `src/pages/${pascal}.tsx`, title: page.title }
}

function parsePlan(data: RawPlan, fallbackRefs: CatalogTemplate[]): FactoryPlan {
  const title = s(data.title, 'Sitio Web', 60)
  const summary = s(data.summary, '', 400)

  const rawPages = Array.isArray(data.pages) ? data.pages : []
  const pages: FactoryPage[] = []
  for (const item of rawPages) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { path?: unknown; title?: unknown; sections?: unknown }
    const path = sanitizePagePath(rec.path)
    if (!path) continue
    const sections = Array.isArray(rec.sections)
      ? rec.sections.map((x) => s(x, 'sección', 80)).slice(0, 8)
      : []
    pages.push({ path, title: s(rec.title, title, 80), sections })
    if (pages.length >= MAX_PAGES) break
  }
  if (pages.length === 0) throw new WebFactoryError('El plan no produjo páginas utilizables.', 'invalid_plan')
  // index.html SIEMPRE existe.
  if (!pages.some((p) => p.path === 'index.html')) {
    pages.unshift({ path: 'index.html', title, sections: ['hero', 'características', 'cta', 'footer'] })
  }

  const framework: SiteFramework = data.framework === 'react' ? 'react' : 'html'

  const ds = data.designSystem ?? {}
  const designSystem: Record<string, string> = {
    paletteName: s(ds.paletteName, 'Elegante oscuro', 40),
    bg: s(ds.bg, '#0c0f14', 20),
    surface: s(ds.surface, '#121722', 20),
    text: s(ds.text, '#e8eaf0', 20),
    muted: s(ds.muted, '#9aa3b2', 20),
    primary: s(ds.primary, '#10b981', 20),
    accent: s(ds.accent, '#d4b483', 20),
    radius: s(ds.radius, '14px', 12),
    shadow: s(ds.shadow, '0 18px 40px rgba(0,0,0,.35)', 80),
    headingFont: s(ds.headingFont, 'Georgia, "Times New Roman", serif', 90),
    bodyFont: s(ds.bodyFont, 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 90),
    motion: s(ds.motion, 'revelación sutil al hacer scroll, microinteracciones en botones', 140),
  }

  const images: FactoryPlan['images'] = []
  if (Array.isArray(data.images)) {
    for (const img of data.images.slice(0, 2)) {
      if (!img || typeof img !== 'object') continue
      const rec = img as { slot?: unknown; prompt?: unknown; size?: unknown }
      const slot = s(rec.slot, '', 40).replace(/[^\w-]/g, '')
      const prompt = s(rec.prompt, '', 300)
      if (!slot || !prompt) continue
      const size = ['1344x768', '1152x864', '1024x1024'].includes(String(rec.size)) ? String(rec.size) : '1344x768'
      images.push({ slot, prompt, size })
    }
  }

  const catalogUrls = new Set(fallbackRefs.map((r) => r.repoUrl))
  const references: FactoryPlan['references'] = []
  if (Array.isArray(data.references)) {
    for (const ref of data.references.slice(0, 4)) {
      if (!ref || typeof ref !== 'object') continue
      const rec = ref as { name?: unknown; repoUrl?: unknown; license?: unknown; usage?: unknown }
      const repoUrl = s(rec.repoUrl, '', 200)
      if (!catalogUrls.has(repoUrl)) continue // solo referencias reales del catálogo
      const cat = fallbackRefs.find((r) => r.repoUrl === repoUrl)
      references.push({
        name: s(rec.name, cat?.name ?? 'Recurso', 80),
        repoUrl,
        license: cat?.licenseSpdx ?? (cat?.status === 'referencia' ? 'sin licencia clara' : 'MIT'),
        usage: 'referencia-visual',
      })
    }
  }
  if (references.length === 0 && fallbackRefs.length > 0) {
    for (const cat of fallbackRefs.slice(0, 3)) {
      references.push({
        name: cat.name,
        repoUrl: cat.repoUrl,
        license: cat.licenseSpdx ?? (cat.status === 'referencia' ? 'sin licencia clara' : 'MIT'),
        usage: 'referencia-visual',
      })
    }
  }

  return {
    title,
    summary: summary || 'Sitio web profesional generado con OE AI Web Factory.',
    siteType: s(data.siteType, 'sitio web profesional', 60),
    aesthetic: s(data.aesthetic, 'moderno y elegante', 120),
    framework,
    designSystem,
    pages,
    interactions: Array.isArray(data.interactions) ? data.interactions.map((x) => s(x, '', 100)).filter(Boolean).slice(0, 6) : [],
    images,
    references,
  }
}

/* ── Prompts: planificador ────────────────────────────────────────────────── */

function plannerSystemPrompt(): string {
  return [
    'Eres el Planificador de OE AI Web Factory: diseñas sitios web de NIVEL ELITE (agencia premium ganadora de premios), coherentes y con contenido creíble.',
    'Aplicas los principios de UI UX Pro Max (79 estilos, 192 paletas, 74 emparejamientos tipográficos, 119 guías UX) y los patrones de componentes de daisyUI, HugoBlox Kit y HyperUI.',
    'Responde ÚNICAMENTE con JSON válido, sin markdown, con esta forma exacta:',
    '{',
    '  "title": "nombre del sitio (máx 50 car.)",',
    '  "summary": "1-2 frases del concepto",',
    '  "siteType": "agencia | clínica | saas | restaurante | portafolio | ecommerce | ...",',
    '  "aesthetic": "dirección visual concreta (ej: lujo minimalista, cálido artesanal, tech limpio)",',
    '  "framework": "html",',
    '  "designSystem": {"paletteName": "...", "bg": "#hex", "surface": "#hex", "text": "#hex", "muted": "#hex", "primary": "#hex", "accent": "#hex", "radius": "14px", "shadow": "css box-shadow", "headingFont": "font stack de sistema", "bodyFont": "font stack de sistema", "motion": "1 frase con las animaciones protagonistas"},',
    '  "pages": [{"path": "index.html", "title": "Inicio", "sections": ["hero animado", "logos", "servicios", "stats", "testimonios", "faq", "cta", "footer"]}],',
    '  "interactions": ["menú móvil", "reveal al scroll", "titular animado letra a letra", "contadores de stats", "marquee de logos", "acordeón FAQ", ...],',
    '  "images": [{"slot": "hero", "prompt": "descripción fotorrealista en inglés", "size": "1344x768"}],',
    '  "references": [{"name": "...", "repoUrl": "URL EXACTA de la lista", "license": "..."}]',
    '}',
    'Reglas de ELITE (nivel Awwwards/Godly):',
    '- designSystem con CONTRASTE real (texto legible, ≥ 7:1), 1 primario + 1 acento, sin #000 ni #FFFFFF puros; superficies con matices de la paleta; sombra suave multicapa (no dura).',
    '- Tipografía de SISTEMA emparejada con intención (principio UI UX Pro Max de pairing): display serif (Georgia/Iowan) × sans body para lujo/editorial; sans geométrica con tracking apretado para tech; serif humanista para salud/bienestar. NADA de Google Fonts/CDN.',
    '- Escala de espaciado de 8pt y ritmo visual: secciones alternando fondo bg/surface, intros kicker+h2+lead, aire generoso (padding 96-120px).',
    '- Jerarquía UX: 1 h1 por página, un solo mensaje por sección, máx 2 CTA simultáneos, estados hover/focus en TODO elemento interactivo.',
    '- MOTION con propósito: titular del hero animado letra a letra, reveal escalonado de tarjetas, iconos con flotación suave, números que cuentan, marquee infinito de logos, botones con brillo al pasar. Todo desactivable (prefers-reduced-motion).',
    '- Estructura que transmita confianza: nav sticky con CTA, hero con prueba social, muro/marquee de logos, stats con cifras reales, features con iconos SVG, testimonios con nombre y cargo, FAQ, CTA final en tarjeta con degradado, footer de 4 columnas.',
    '- SOLO secciones con sentido para el negocio (no fuerces todas).',
    '- "framework": "html" (sitio estático multi-página, POR DEFECTO) — solo "react" si el usuario pide explícitamente React, TSX, Next.js, Vite, SPA o componentes.',
    '- Máximo 4 páginas; usa EXACTAMENTE las rutas .html del listado permitido si te lo doy (index.html requerido).',
    '- "references": elige 2-3 de la lista entregada copiando su repoUrl EXACTO (daisyUI, HugoBlox Kit, HyperUI, UI UX Pro Max y demás). NO inventes repos.',
    '- images: 0-2 imágenes esenciales (hero o galería); prompts descriptivos en inglés; size "1344x768" (panorámica) o "1024x1024".',
    '- Contenido del sitio en ESPAÑOL, con datos concretos y creíbles (cifras, nombres de servicios, horarios); sin claves ni servicios externos de pago.',
  ].join('\n')
}

function plannerUserPrompt(brief: string, refs: CatalogTemplate[], componentKinds: Array<{ category: string; examples: string[] }>, existingPaths: string[] | null): string {
  const refList = refs
    .map((r) => `- ${r.name} · ${r.repoUrl} · licencia ${r.licenseSpdx ?? 'sin licencia clara'}${r.status === 'referencia' ? ' (SOLO referencia visual)' : ''}`)
    .join('\n')
  const compList = componentKinds.map((c) => `${c.category}: ${c.examples.slice(0, 2).join(' | ')}`).join('; ')
  const pagesRule = existingPaths
    ? `Proyecto existente con páginas: ${existingPaths.join(', ')} — el sitio ya tiene estructura; el plan debe respetarla o proponer la mínima mejora.`
    : 'Rutas .html permitidas: index.html, y hasta 3 más tipo "servicios.html", "galeria.html", "contacto.html", "menu.html", "equipo.html", "blog.html", "precios.html", "habitaciones.html", "destinos.html", "propiedades.html".'
  return [
    `Petición del usuario:\n"""\n${brief.slice(0, 3000)}\n"""`,
    pagesRule,
    `Referencias DISPONIBLES del catálogo (usa su repoUrl EXACTO; HugoBlox Kit aporta los patrones de headers/heroes/secciones más profesionales):\n${refList}`,
    `Patrones de secciones disponibles (sigue su anatomía para que el sitio se vea profesional):\n${compList}`,
    'Diseña el sitio completo (plan contrato) con nivel de agencia premium.',
  ].join('\n\n')
}

/* ── Prompts: shell (CSS compartido + JS para html / site.tsx para react) ─── */

function shellCssRules(): string[] {
  return [
    'styles.css OBLIGATORIO (nivel ELITE — cada detalle pulido, animaciones CSS reales):',
    '- :root con variables EXACTAS: --wf-bg, --wf-surface, --wf-text, --wf-muted, --wf-primary, --wf-accent, --wf-radius, --wf-shadow, --wf-heading, --wf-body (valores del sistema de diseño dado) + derivadas: --wf-border (borde sutil 1px), --wf-primary-soft (primario 12%), --wf-surface-2 (superficie elevada).',
    '- Base: *{box-sizing} html{scroll-behavior:smooth} body{background var(--wf-bg); color var(--wf-text); font var(--wf-body); line-height 1.65; -webkit-font-smoothing} ::selection con primario. Scrollbar fino personalizado (webkit).',
    '- Tipografía fluida con clamp(): h1 display clamp(2.4rem, 5vw, 4rem) con var(--wf-heading), letter-spacing -0.025em, line-height 1.05; h2 clamp(1.8rem, 3vw, 2.6rem); .wf-lead clamp(1.05rem, 1.6vw, 1.3rem) en --wf-muted. Texto del hero con acento en degradado: .wf-gradient-text {background: linear-gradient(90deg, var(--wf-primary), var(--wf-accent)); -webkit-background-clip: text; background-clip: text; color: transparent}.',
    '- ANIMACIONES ELITE (todas con @keyframes y desactivables con prefers-reduced-motion):',
    '  · Letras animadas: .wf-letter {display:inline-block; opacity:0; transform:translateY(0.6em) rotate(4deg); animation: wf-letter-in .7s cubic-bezier(.2,.7,.2,1) forwards; animation-delay: calc(var(--i) * 45ms)} con @keyframes wf-letter-in {to {opacity:1; transform:none}}. El JS reparte --i.',
    '  · Orbes flotantes del hero: .wf-orb {position:absolute; border-radius:50%; filter:blur(70px); opacity:.5; animation: wf-orb-drift 14s ease-in-out infinite alternate} con @keyframes wf-orb-drift (translate + scale suaves); .wf-orb-1 con primario, .wf-orb-2 con acento (delay negativo).',
    '  · Iconos vivos: .wf-card-icon svg {transition: transform .3s} .wf-card:hover .wf-card-icon svg {transform: translateY(-4px) scale(1.12) rotate(-4deg)}; .wf-float {animation: wf-float 5s ease-in-out infinite} @keyframes wf-float {50% {transform: translateY(-8px)}}.',
    '  · Botones con brillo: .wf-btn-primary {position:relative; overflow:hidden} .wf-btn-primary::after {content:""; position:absolute; inset:0; background:linear-gradient(105deg, transparent 40%, rgba(255,255,255,.35) 50%, transparent 60%); transform:translateX(-120%); transition:transform .6s} .wf-btn-primary:hover::after {transform:translateX(120%)} y hover: translateY(-2px) + sombra primaria.',
    '  · Marquee infinito de logos: .wf-marquee {overflow:hidden; mask-image:linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent)} .wf-marquee-track {display:flex; gap:3rem; width:max-content; animation: wf-marquee 28s linear infinite} @keyframes wf-marquee {to {transform:translateX(-50%)}} .wf-marquee:hover .wf-marquee-track {animation-play-state:paused}.',
    '  · Cards 3D: .wf-card {transition: transform .3s, box-shadow .3s, border-color .3s} .wf-card:hover {transform: translateY(-6px) perspective(800px) rotateX(2deg); box-shadow: var(--wf-shadow); border-color: color-mix(in srgb, var(--wf-primary) 35%, transparent)}.',
    '  · Subrayado animado en nav: .wf-menu a {position:relative} .wf-menu a::after {content:""; position:absolute; left:0; bottom:-4px; width:100%; height:2px; background:var(--wf-primary); transform:scaleX(0); transform-origin:right; transition:transform .3s} .wf-menu a:hover::after, .wf-menu a.is-active::after {transform:scaleX(1); transform-origin:left}.',
    '  · Reveal escalonado: .wf-reveal (opacity 0 + translateY(26px), transition .8s cubic-bezier) y .wf-reveal-in (visible); hijos con transition-delay: calc(var(--d) * 90ms) cuando el padre tiene data-wf-stagger.',
    '- Clases .wf-* EXACTAS que las páginas usarán:',
    '  · wf-container (max-width 1160px + padding lateral), wf-section (padding vertical clamp(72px, 10vw, 128px)), wf-section-alt (fondo surface para alternar ritmo).',
    '  · wf-hero (min-height 92vh, position relative, overflow hidden, grid alineado), wf-hero-bg (contenedor absoluto de orbes), wf-orb / wf-orb-1 / wf-orb-2, wf-hero-center (variante centrada), wf-hero-media (wf-media con borde y sombra, tilt sutil).',
    '  · wf-nav (sticky top 0, z 50, fondo bg 80% + backdrop-filter blur 16px, borde inferior --wf-border), wf-nav-inner, wf-logo (peso 800 con punto de acento), wf-menu, wf-menu a (muted → texto), .is-active (color primario + subrayado), wf-burger (solo móvil), wf-menu-open (panel deslizante móvil).',
    '  · wf-btn, wf-btn-primary (con brillo), wf-btn-ghost (borde → primario), wf-btn-lg.',
    '  · wf-kicker (mayúsculas pequeñas con letter-spacing .16em, color primario, guión animado que crece), wf-title, wf-lead.',
    '  · wf-grid (auto-fit minmax 260px), wf-grid-3, wf-grid-4, wf-card (con tilt 3D + borde), wf-card-icon (tile 48px con fondo --wf-primary-soft, radio, svg 24px), wf-card h3/p.',
    '  · wf-stats (banda grid), .wf-stat-number (clamp 2.4-3.2rem, peso 800, degradado primario→accent con background-clip), .wf-stat-label (muted mayúsculas pequeñas).',
    '  · wf-marquee + wf-marquee-track (logos: items con icono/texto monocromo opacity .55, hover 1).',
    '  · wf-quote (testimonio: comilla decorativa enorme en primario-soft, cita itálica, .wf-avatar círculo, nombre + cargo muted), .wf-quote-featured (2 col con foto).',
    '  · wf-price (nombre, .wf-price-value grande, lista con ✓ en primario, .wf-price-featured con borde primario + badge "Recomendado" + escala 1.03).',
    '  · wf-faq (details/summary estilizados: summary con icono +/− rotando en open, borde inferior, padding cómodo).',
    '  · wf-cta-band (tarjeta final: degradado primario→accent 12%, borde, radius grande, padding extra, centrado, con orbe decorativo).',
    '  · wf-media (degradado de paleta + relative + overflow hidden + min-height + radius), wf-media img (absolute cover).',
    '  · wf-badge/wf-chip, wf-team-card, wf-gallery + wf-gallery-item (overlay con título al hover: gradiente inferior + translateY del texto).',
    '  · wf-form (inputs fondo surface, borde, focus anillo primario), wf-contact (grid form + datos).',
    '  · wf-footer (borde superior, 4 columnas → 1 móvil, títulos mayúsculas, enlaces muted hover primario, línea legal con año).',
    '  · wf-reveal / wf-reveal-in.',
    '- Responsive @media (max-width: 960px) y (max-width: 760px): grids colapsan, menú panel, hero 1 columna, orbes reducidos.',
    '- @media (prefers-reduced-motion: reduce): anula wf-letter, wf-orb, wf-float, wf-marquee (animation none; opacity/transform finales), .wf-reveal {transition:none; transform:none; opacity:1}.',
    '- Calidad: 240-340 líneas de CSS organizadas por bloques con comentarios /* ── Sección ── */.',
  ]
}

function shellSystemPrompt(framework: SiteFramework): string {
  if (framework === 'react') {
    return [
      'Eres el Generador del Shell de OE AI Web Factory (modo React ELITE con daisyUI): creas src/styles.css (Tailwind 4 + daisyUI 5 con tema personalizado) y src/components/site.tsx compartidos para UN sitio React coherente.',
      'Responde ÚNICAMENTE con JSON válido: {"css": "...", "tsx": "..."}',
      'src/styles.css OBLIGATORIO (Tailwind 4 + daisyUI 5 ya instalados como dependencias):',
      '- Primera línea: @import "tailwindcss";',
      '- Segundo bloque: @plugin "daisyui" { themes: light --default, dark; }',
      '- Tercer bloque: @plugin "daisyui/theme" { name: "oetheme"; default: true; color-scheme: "light"; --color-base-100: <fondo del plan>; --color-base-200: <superficie>; --color-base-content: <texto>; --color-primary: <primario>; --color-secondary: <acento>; --color-accent: <acento>; --color-neutral: <texto oscuro>; --radius-box: <radius del plan>; --radius-field: <radius menor>; } — usa los hex EXACTOS del sistema de diseño dado (daisyUI acepta hex).',
      '- Después, CSS global propio: html{scroll-behavior:smooth} body{font-family: <bodyFont del plan>} .font-display{font-family: <headingFont del plan>} ::selection, scrollbar fino, utilidades propias (por ejemplo .wf-gradient-text {background: linear-gradient(90deg, var(--color-primary), var(--color-accent)); -webkit-background-clip:text; background-clip:text; color:transparent}), keyframes de animación propias (wf-float, wf-orb-drift, wf-marquee) y @media (prefers-reduced-motion: reduce) que las desactive.',
      '- 60-120 líneas. Sin clases .wf-* de layout (eso lo cubren daisyUI + Tailwind): solo tema, tipografía y animaciones.',
      'src/components/site.tsx OBLIGATORIO (TypeScript estricto, sin any):',
      "- import { useEffect, useState } from 'react'; iconos de 'lucide-react'; motion de 'framer-motion' (si lo usas).",
      '- export function useHashRoute(): string — hook de enrutamiento por hash: estado de location.hash (sin "#", "/" por defecto), listener "hashchange" con cleanup, devuelve la ruta.',
      '- export function Navbar(): <div className="navbar bg-base-100/80 backdrop-blur border-b border-base-200 sticky top-0 z-50"> con logo (nombre del plan + icono lucide en primary), menú de TODAS las páginas del plan (href="#/ruta", Inicio → "#/", activo según useHashRoute con text-primary), botón CTA <Link/button className="btn btn-primary">, menú móvil con useState + dropdown daisyUI o botón burger, aria-labels.',
      '- export function Footer(): <footer className="footer bg-base-200"> con 4 columnas de contenido REAL del plan (páginas, empresa/legal, contacto, newsletter con onSubmit + useState y alert alert-success), iconos sociales lucide con aria-label, línea legal con {new Date().getFullYear()}.',
      '- export function SectionIntro({ kicker, title, lead }: { kicker: string; title: string; lead?: string }) con badge/kicker en primary, h2 font-display y lead en opacity-70.',
      '- NADA de props sin tipar, librerías fuera de las declaradas, ni class= (usa className).',
      '- Calidad: 130-220 líneas de TSX.',
    ].join('\n')
  }
  return [
    'Eres el Generador del Shell de OE AI Web Factory: creas styles.css y app.js compartidos para UN sitio multi-página coherente.',
    'Responde ÚNICAMENTE con JSON válido: {"css": "...", "js": "..."}',
    ...shellCssRules(),
    'app.js OBLIGATORIO (vanilla, sin dependencias, 80-130 líneas):',
    '- Menú móvil: .wf-burger alterna .wf-menu-open en su header .wf-nav (aria-expanded actualizado).',
    '- Titular letra a letra: para CADA elemento con [data-wf-letters], divide su texto en spans <span class="wf-letter" style="--i:N"> por letra (respetando espacios como textContent normal) y reparte --i incremental. Si prefers-reduced-motion, dejar el texto intacto.',
    '- Reveal escalonado: IntersectionObserver añade .wf-reveal-in a .wf-reveal; los hijos directos de [data-wf-stagger] reciben style.setProperty("--d", i) para el delay (si reduced-motion o sin IO, todo visible inmediatamente).',
    '- Marquee: el track .wf-marquee-track se DUPLICA (clona su contenido una vez) para que el loop infinito sea perfecto.',
    '- Contadores: .wf-stat-number con data-count se anima de 0 a su valor cuando entra en viewport (respeta prefers-reduced-motion: salta al final).',
    '- Formularios: TODOS los form con manejo submit (preventDefault, validación HTML5, feedback visible de éxito en la página, nunca alert()).',
    '- Enlace activo del menú: marca .is-active según location.pathname.',
    '- Año dinámico en [data-wf-year] y anclas con scroll suave.',
    '- Sin console.log.',
  ].join('\n')
}

/* ── Prompts: páginas ─────────────────────────────────────────────────────── */

function pageSystemPrompt(framework: SiteFramework): string {
  if (framework === 'react') {
    return [
      'Eres el Compositor de Páginas de OE AI Web Factory (modo React ELITE): escribes UNA página como componente TSX del sitio, coherente con el shell compartido.',
      'Responde ÚNICAMENTE con JSON válido: {"tsx": "..."}',
      'Reglas obligatorias:',
      '- TypeScript estricto y JSX correcto: className (nunca class), htmlFor, atributos SVG camelCase, comillas dobles.',
      "- 'export default function NombrePagina() { … }' como ÚNICO export por defecto.",
      "- Imports permitidos SOLO: { useState, useEffect } de 'react' (si los usas), iconos de 'lucide-react', componentes de 'framer-motion' (motion), utilidades del shell desde '../components/site' (p. ej. SectionIntro). NADA más (sin react-router, sin imágenes importadas).",
      '- COMPONENTES daisyUI REALES (están instalados y compilados por Tailwind 4): usa sus clases libremente — btn btn-primary, card, badge, stats/stat/stat-title/stat-value, collapse collapse-arrow, timeline, steps, rating/rating-mask, avatar, join, alert, navbar, footer, divider… combínalos con utilidades Tailwind (grid, gap, p-*, text-*, bg-base-100/200, text-base-content, bg-primary/10…).',
      '- ANIMACIONES con framer-motion: envuelve secciones/tarjetas en <motion.section>/<motion.div> con initial={{ opacity: 0, y: 28 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-80px" }} transition={{ duration: 0.6, delay: i * 0.08 }} (escalonado por índice). El titular del hero: <motion.h1> con staggerChildren de spans por letra (cada letra <motion.span> con variants). Iconos: <Zap className="animate-bounce" /> o motion con float suave.',
      '- Iconos: SIEMPRE de lucide-react importados por nombre (Zap, ShieldCheck, Sparkles, ArrowRight, Quote, Star…). NADA de emojis como iconos ni SVG gigantes inline (los pequeños inline son aceptables si falta el icono perfecto).',
      '- Contenido REAL en español específico del negocio: textos persuasivos, cifras concretas, nombres y cargos verosímiles. Nada de Lorem ipsum.',
      '- Imágenes: usa las clases daisyUI (card con figure, avatar) y src={{IMG:slot}} con onError={() => …} si procede; sin slot → composición tipográfica/degradado con Tailwind (bg-gradient-to-br from-primary/20…). PROHIBIDO src externo (Unsplash etc.).',
      '- Formularios controlados con labels visibles, required y onSubmit con preventDefault + estado de éxito visible (alert alert-success daisyUI).',
      '- 80-170 líneas. Accesible: jerarquía h1/h2/h3, aria-label en navegación, contraste garantizado por el tema.',
    ].join('\n')
  }
  return [
    'Eres el Compositor de Páginas de OE AI Web Factory: escribes UNA página HTML del sitio, coherente con el shell compartido.',
    'Responde ÚNICAMENTE con JSON válido: {"html": "..."}',
    'Reglas obligatorias:',
    '- Documento completo: <!DOCTYPE html>, <html lang="es">, head con <title> ÚNICO, meta description específica, meta viewport, <link rel="stylesheet" href="styles.css"> y <script src="app.js" defer></script>.',
    '- Usa EXCLUSIVAMENTE las clases .wf-* del shell (wf-nav, wf-hero, wf-section, wf-section-alt, wf-grid, wf-card, wf-card-icon, wf-btn, wf-media, wf-stats, wf-quote, wf-price, wf-faq, wf-cta-band, wf-gallery, wf-reveal…) + inline <style> pequeño SOLO para detalles propios de esta página.',
    '- Header de navegación IDÉNTICO en estructura a las otras páginas: wf-nav con wf-logo (nombre del sitio), menú con enlaces a TODAS las páginas del sitio (la actual con clase is-active), botón CTA wf-btn-primary y wf-burger.',
    '- Hero (index): fondo con .wf-hero-bg y DOS orbes (.wf-orb.wf-orb-1 primario + .wf-orb.wf-orb-2 acento); kicker; titular <h1 data-wf-letters> (el JS lo anima letra a letra) con 1-2 palabras en <span class="wf-gradient-text">; lead; 2 CTAs (primario y ghost); fila de confianza (chips o mini-stats). Páginas interiores: hero compacto (wf-section con kicker + h1 + lead).',
    '- Secciones con ritmo: alterna wf-section y wf-section-alt; intros kicker + h2 + lead; TARJETAS con icono SVG dentro de .wf-card-icon (los iconos “viven” con el hover y .wf-float en el hero); stats con data-count para contadores; testimonios con nombre y cargo; FAQ con <details> en wf-faq; CTA final en wf-cta-band; logos en .wf-marquee > .wf-marquee-track (items monocromos).',
    '- Footer wf-footer IDÉNTICO en todas: 4 columnas (enlaces del sitio, empresa/legal, contacto real del negocio, newsletter con form), [data-wf-year] y enlaces internos reales.',
    '- Contenido REAL en español específico del negocio (nada de Lorem ipsum ni "Ejemplo"). Textos persuasivos y concretos.',
    "- Imágenes: <div class=\"wf-media\"><img src=\"{{IMG:slot}}\" alt=\"descripción\" loading=\"lazy\" onerror=\"this.remove()\"></div> usando los slots dados. Si no se indica slot para una zona, usa composición tipográfica/degradado sin img.",
    '- Iconografía: SVG inline pequeños (trazo currentColor). NADA de CDNs, Google Fonts, ni recursos externos.',
    '- PROHIBIDO enlazar imágenes externas (Unsplash, Pexels, pexels.com, images.unsplash.com, cualquier https:// en src): usa SOLO los slots {{IMG:slot}} disponibles o composición tipográfica/degradado .wf-media sin img. Un src externo = fallo de calidad.',
    '- Cada sección principal con clase wf-reveal (grids con data-wf-stagger). Formularios con labels visibles, placeholders y required.',
    '- 100-180 líneas de HTML. Accesible: jerarquía h1→h2→h3, aria-label en nav y burger.',
  ].join('\n')
}

function pageUserPrompt(planJson: string, page: FactoryPage, allPages: FactoryPage[], imageSlots: string[], framework: SiteFramework): string {
  return [
    `Plan contrato del sitio:\n${planJson.slice(0, 6500)}`,
    `Página a escribir: ${page.path} — título "${page.title}" — secciones: ${page.sections.join(', ')}.`,
    `Otras páginas del sitio (para el menú): ${allPages.map((p) => `${p.path} (${p.title})`).join(', ')}.`,
    imageSlots.length > 0
      ? `Slots de imagen disponibles (usa {{IMG:slot}} donde aporte): ${imageSlots.join(', ')}. Asigna el más importante al hero.`
      : 'NO hay imágenes: usa composición tipográfica y degradados .wf-media sin img.',
    framework === 'react' ? 'Escribe el componente TSX completo de la página.' : 'Escribe la página HTML completa.',
  ].join('\n\n')
}

function updaterSystemPrompt(framework: SiteFramework): string {
  return [
    'Eres el Editor de OE AI Web Factory: modificas un sitio existente según la petición del usuario.',
    'Responde ÚNICAMENTE con JSON válido: {"summary": "1-2 frases", "files": [{"path": "...", "content": "..."}]}',
    'Reglas obligatorias:',
    '- Devuelve el contenido COMPLETO de cada archivo que cambies (máx 4). Los no incluidos permanecen.',
    framework === 'react'
      ? '- Rutas válidas: src/…​.tsx, src/…​.ts y src/styles.css (componentes React con className, TypeScript estricto).'
      : '- Rutas válidas: páginas .html, styles.css y app.js.',
    '- Conserva las clases .wf-*, la estructura de navegación y la coherencia del sistema de diseño.',
    '- Sin CDNs ni recursos externos. Sin claves. Contenido en español.',
  ].join('\n')
}

/* ── Proyecto React determinista (scaffold sin LLM) ───────────────────────── */

function reactSlug(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  return base || 'sitio-web'
}

function reactScaffold(plan: FactoryPlan): Array<{ path: string; content: string }> {
  const name = reactSlug(plan.title)
  const pkg = {
    name,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview', typecheck: 'tsc --noEmit' },
    dependencies: {
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      'framer-motion': '^11.15.0',
      'lucide-react': '^0.469.0',
    },
    devDependencies: {
      '@tailwindcss/vite': '^4.1.4',
      '@types/react': '^18.3.12',
      '@types/react-dom': '^18.3.1',
      '@vitejs/plugin-react': '^4.3.4',
      daisyui: '^5.0.0',
      tailwindcss: '^4.1.4',
      typescript: '~5.6.2',
      vite: '^5.4.11',
    },
  }
  const tsconfig = {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      isolatedModules: true,
      moduleDetection: 'force',
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
      noFallthroughCasesInSwitch: true,
      types: ['vite/client'],
    },
    include: ['src'],
  }
  return [
    { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
    { path: 'tsconfig.json', content: JSON.stringify(tsconfig, null, 2) + '\n' },
    {
      path: 'vite.config.ts',
      content: [
        "import { defineConfig } from 'vite'",
        "import react from '@vitejs/plugin-react'",
        "import tailwindcss from '@tailwindcss/vite'",
        '',
        'export default defineConfig({',
        '  plugins: [react(), tailwindcss()],',
        '})',
        '',
      ].join('\n'),
    },
    {
      path: 'index.html',
      content: [
        '<!DOCTYPE html>',
        '<html lang="es" data-theme="oetheme">',
        '  <head>',
        '    <meta charset="UTF-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        `    <meta name="description" content="${plan.summary.replace(/"/g, '&quot;').slice(0, 160)}" />`,
        `    <title>${plan.title}</title>`,
        '  </head>',
        '  <body>',
        '    <div id="root"></div>',
        '    <script type="module" src="/src/main.tsx"></script>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
    },
    {
      path: 'src/main.tsx',
      content: [
        "import { StrictMode } from 'react'",
        "import { createRoot } from 'react-dom/client'",
        "import App from './App'",
        "import './styles.css'",
        '',
        "createRoot(document.getElementById('root')!).render(",
        '  <StrictMode>',
        '    <App />',
        '  </StrictMode>,',
        ')',
        '',
      ].join('\n'),
    },
    { path: 'src/vite-env.d.ts', content: '/// <reference types="vite/client" />\n' },
    { path: '.gitignore', content: 'node_modules\ndist\n*.local\n' },
  ]
}

/**
 * Verificación REAL de compilación para proyectos React: instala las
 * dependencias (bun install), comprueba tipos (tsc --noEmit) y compila
 * (vite build) en un directorio temporal aislado. Best-effort y acotado:
 * si algo falla, el resultado se informa HONESTAMENTE (nunca "validado" sin
 * haber ejecutado pruebas).
 */
async function verifyReactBuild(files: Array<{ path: string; content: string }>): Promise<{
  install: { status: 'ok' | 'revisado' | 'no-ejecutada'; detail: string }
  typecheck: { status: 'ok' | 'revisado' | 'no-ejecutada'; detail: string }
  compile: { status: 'ok' | 'revisado' | 'no-ejecutada'; detail: string }
  /** Errores de tipos por archivo (para el paso de corrección automática). */
  errors: Array<{ file: string; message: string }>
}> {
  const { execFile } = await import('node:child_process')
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const notRun = (why: string) => ({ status: 'no-ejecutada' as const, detail: why })

  let dir: string | null = null
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'oe-wf-build-'))
    for (const f of files) {
      const target = path.join(dir, f.path)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, f.content, 'utf8')
    }
    const run = (cmd: string, args: string[], timeoutMs: number) =>
      new Promise<{ ok: boolean; output: string }>((resolve) => {
        execFile(cmd, args, { cwd: dir!, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          const output = `${stdout}\n${stderr}`.trim()
          resolve({ ok: !err, output })
        })
      })

    const install = await run('bun', ['install', '--no-progress'], 120_000)
    if (!install.ok) {
      return {
        install: { status: 'revisado', detail: `bun install falló: ${install.output.split('\n').slice(0, 2).join(' | ').slice(0, 200)}` },
        typecheck: notRun('No se ejecutó: la instalación de dependencias falló.'),
        compile: notRun('No se ejecutó: la instalación de dependencias falló.'),
        errors: [],
      }
    }
    const pkgCount = install.output.match(/(\d+) packages? installed/)?.[1] ?? 'los'

    const typecheck = await run('bunx', ['tsc', '--noEmit'], 120_000)
    if (!typecheck.ok) {
      // Extraer errores por archivo: "src/pages/Home.tsx(212,23): error TS1145: …"
      const errors: Array<{ file: string; message: string }> = []
      for (const line of typecheck.output.split('\n')) {
        const m = line.match(/^([\w/.-]+\.(?:tsx|ts))\((\d+)[,)]/)
        if (m && line.includes('error TS')) errors.push({ file: m[1], message: line.slice(0, 240) })
      }
      const firstErr = errors.slice(0, 2).map((e) => e.message).join(' | ') || typecheck.output.slice(0, 200)
      return {
        install: { status: 'ok', detail: `Dependencias instaladas (${pkgCount} paquetes: react, framer-motion, lucide-react, tailwindcss, daisyui, vite…).` },
        typecheck: { status: 'revisado', detail: `tsc --noEmit encontró errores de tipos: ${firstErr.slice(0, 220)}` },
        compile: notRun('No se ejecutó: los tipos no compilan.'),
        errors: errors.slice(0, 8),
      }
    }

    const build = await run('bun', ['run', 'build'], 150_000)
    if (!build.ok) {
      const firstErr = build.output.split('\n').filter(Boolean).slice(-3).join(' | ')
      return {
        install: { status: 'ok', detail: `Dependencias instaladas (${pkgCount} paquetes: react, framer-motion, lucide-react, tailwindcss, daisyui, vite…).` },
        typecheck: { status: 'ok', detail: 'tsc --noEmit sin errores de tipos.' },
        compile: { status: 'revisado', detail: `vite build falló: ${firstErr.slice(0, 220)}` },
        errors: [],
      }
    }
    const distMatch = build.output.match(/dist[\s\S]*?built in ([\d.]+)s/i)
    return {
      install: { status: 'ok', detail: `Dependencias instaladas (${pkgCount} paquetes: react, framer-motion, lucide-react, tailwindcss, daisyui, vite…).` },
      typecheck: { status: 'ok', detail: 'tsc --noEmit sin errores de tipos.' },
      compile: { status: 'ok', detail: `vite build COMPLETADO${distMatch ? ` en ${distMatch[1]}s` : ''}: el proyecto compila de verdad (CSS de daisyUI/Tailwind incluido).` },
      errors: [],
    }
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 160) : 'entorno sin capacidad de instalación'
    return {
      install: notRun(`No se pudo ejecutar la instalación real: ${why}`),
      typecheck: notRun('No se ejecutó: la verificación de compilación no estuvo disponible.'),
      compile: notRun('No se ejecutó: la verificación de compilación no estuvo disponible.'),
      errors: [],
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Paso de CORRECCIÓN automática ("valida y corrige"): si tsc detecta errores en
 * archivos generados, el núcleo reescribe cada archivo roto con el reporte de
 * errores en la mano (1 intento por archivo, máx 2 archivos).
 */
async function repairReactFiles(
  plan: FactoryPlan,
  deliverable: Array<{ path: string; content: string }>,
  errors: Array<{ file: string; message: string }>,
): Promise<number> {
  const byFile = new Map<string, string[]>()
  for (const e of errors) {
    if (!deliverable.some((f) => f.path === e.file)) continue // solo reparamos archivos que entregamos
    const list = byFile.get(e.file) ?? []
    list.push(e.message)
    byFile.set(e.file, list)
  }
  let repaired = 0
  for (const [file, messages] of [...byFile.entries()].slice(0, 2)) {
    const current = deliverable.find((f) => f.path === file)
    if (!current) continue
    try {
      const res = await buildChatJson<{ tsx?: unknown }>(
        pageSystemPrompt('react'),
        [
          `Plan contrato del sitio:\n${JSON.stringify(plan).slice(0, 4500)}`,
          `El siguiente archivo tiene ERRORES DE TIPO/SINTAXIS de TypeScript que DEBES corregir:\n--- ${file} (versión con errores) ---\n${current.content.slice(0, 30_000)}`,
          `Errores reportados por tsc:\n${messages.join('\n').slice(0, 1500)}`,
          'Devuelve el JSON con el archivo COMPLETO corregido: mismo export default, mismas secciones y contenido; SOLO corrige los errores de sintaxis/tipos sin romper nada más. JSX válido: cierra todas las etiquetas y llaves.',
        ].join('\n\n'),
      )
      const tsx = s(res.data.tsx, '', 90_000)
      if (tsx && /export\s+default\s+function/.test(tsx)) {
        current.content = tsx
        repaired++
        console.error(`[web-factory] archivo ${file} reparado (${messages.length} errores)`)
      }
    } catch (err) {
      console.error(`[web-factory] reparación de ${file} falló: ${err instanceof Error ? err.message.slice(0, 100) : 'sin detalle'}`)
    }
  }
  return repaired
}

/** App.tsx determinista: enrutador por hash + Navbar/Footer del shell + páginas generadas. */
function reactAppSource(plan: FactoryPlan, modules: Array<{ route: string; name: string; title: string }>): string {
  const imports = modules.map((m) => `import ${m.name} from './pages/${m.name}'`).join('\n')
  const entries = modules
    .map((m) => `  { route: '${m.route}', title: '${m.title.replace(/'/g, "\\'")}', Component: ${m.name} },`)
    .join('\n')
  return [
    "import { useEffect } from 'react'",
    "import { Navbar, Footer, useHashRoute } from './components/site'",
    imports,
    '',
    `const BRAND = '${plan.title.replace(/'/g, "\\'")}'`,
    '',
    'const PAGES: Array<{ route: string; title: string; Component: () => JSX.Element }> = [',
    entries,
    ']',
    '',
    'export default function App() {',
    '  const route = useHashRoute()',
    '  const active = PAGES.find((p) => p.route === route) ?? PAGES[0]',
    '  useEffect(() => {',
    "    document.title = `${active.title} · ${BRAND}`",
    '    window.scrollTo(0, 0)',
    '  }, [active])',
    '  return (',
    '    <div className="wf-app">',
    '      <Navbar />',
    '      <main>',
    '        <active.Component />',
    '      </main>',
    '      <Footer />',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
}

/* ── Imágenes ─────────────────────────────────────────────────────────────── */

const TINY_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"></svg>',
  )

async function generatePlanImages(
  sessionId: string,
  images: FactoryPlan['images'],
): Promise<Array<{ slot: string; assetId: string; url: string }>> {
  if (images.length === 0) return []
  const out: Array<{ slot: string; assetId: string; url: string }> = []
  await Promise.all(
    images.map(async (img) => {
      try {
        const { default: ZAI } = await import('z-ai-web-dev-sdk')
        const zai = await ZAI.create()
        const result = await zai.images.generations.create({ prompt: img.prompt, size: img.size as '1344x768' })
        const base64 = result?.data?.[0]?.base64
        if (!base64) return
        const buffer = Buffer.from(base64, 'base64')
        const asset = await db.generatedAsset.create({
          data: { sessionId, prompt: img.prompt.slice(0, 900), size: img.size, mime: 'image/png', data: buffer },
        })
        out.push({ slot: img.slot, assetId: asset.id, url: `/api/assets/${asset.id}` })
      } catch (err) {
        console.error(`[web-factory] imagen "${img.slot}" falló (continúa con degradado):`, err instanceof Error ? err.message.slice(0, 120) : err)
      }
    }),
  )
  return out
}

function injectImages(html: string, images: Array<{ slot: string; url: string }>): string {
  let out = html
  for (const img of images) {
    out = out.replaceAll(`{{IMG:${img.slot}}}`, img.url)
  }
  // Slots sin imagen (o fallo): placeholder mínimo válido (el degradado .wf-media manda).
  out = out.replace(/{{IMG:[\w-]+}}/g, TINY_SVG)
  return out
}

/**
 * Saneo anti-recursos-externos: elimina <img> con src http(s) que no sean
 * /api/assets (el modelo a veces cuela Unsplash). El contenedor .wf-media
 * conserva su degradado → el diseño no se rompe y quedan CERO imágenes rotas.
 * Los <link>/<script> externos también se eliminan (offline-first).
 */
function stripExternalAssets(html: string): string {
  let out = html.replace(/<img\b[^>]*\ssrc=["']https?:\/\/[^"']+["'][^>]*>/gi, (tag) => {
    if (tag.includes('/api/assets/')) return tag
    return ''
  })
  out = out.replace(/<link\b[^>]*\shref=["']https?:\/\/[^"']+["'][^>]*\/?>/gi, '')
  out = out.replace(/<script\b[^>]*\ssrc=["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>/gi, '')
  // Fuentes de Google (preconnect + stylesheet) por si cuelan en el head.
  out = out.replace(/<link\b[^>]*fonts\.googleapis\.com[^>]*\/?>/gi, '')
  out = out.replace(/<link\b[^>]*fonts\.gstatic\.com[^>]*\/?>/gi, '')
  return out
}

/* ── README determinista (procedencia + licencias + guía) ─────────────────── */

function buildReadme(plan: FactoryPlan, fileNames: string[], checks: FactoryCheck[]): string {
  const refs = plan.references
    .map((r) => `- ${r.name} — ${r.repoUrl} — licencia: ${r.license} — uso: ${r.usage} (patrón visual; el código de este proyecto es propio)`)
    .join('\n')
  const checkLines = checks.map((c) => `- [${c.status}] ${c.check}: ${c.detail}`).join('\n')
  const isReact = plan.framework === 'react'
  return [
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    isReact
      ? 'Generado por **OE AI Web Factory** (módulo de OE AI). Proyecto **React 18 + TypeScript + Vite** con componentes .tsx reales.'
      : 'Generado por **OE AI Web Factory** (módulo de OE AI). Sitio estático: HTML + CSS + JS vanilla, sin dependencias ni compilación.',
    '',
    isReact
      ? [
          '## Cómo ejecutarlo',
          '```bash',
          'npm install',
          'npm run dev      # desarrollo en http://localhost:5173',
          'npm run build    # producción en dist/',
          'npm run preview  # sirve la build de producción',
          '```',
          '',
          '## Estructura',
          '- `src/components/site.tsx` — Navbar, Footer, useHashRoute (enrutado por hash) y utilidades compartidas.',
          '- `src/pages/*.tsx` — una página por componente (rutas `#/`, `#/servicios`, …).',
          '- `src/App.tsx` — enrutador por hash + layout compartido.',
          '- `src/styles.css` — sistema de diseño (variables `--wf-*` y clases `.wf-*`).',
          '',
          '## Personalización',
          '- Colores/radios/sombras: edita las variables `:root` al inicio de `src/styles.css`.',
          '- Contenido: cada página es un componente .tsx legible.',
          '- Imágenes: sustituye las URLs `/api/assets/...` por tus propios archivos.',
        ].join('\n')
      : [
          '## Páginas',
          plan.pages.map((p) => `- ${p.path} — ${p.title} (${p.sections.join(', ')})`).join('\n'),
          '',
          '## Cómo ejecutarlo',
          'Opción 1: abre `index.html` en tu navegador (todo funciona offline salvo las imágenes generadas, documentadas abajo).',
          'Opción 2: `npx serve .` o `python3 -m http.server` para servirlo localmente.',
          '',
          '## Estructura',
          fileNames.map((f) => `- ${f}`).join('\n'),
          '',
          '## Personalización',
          '- Colores/radios/sombras: edita las variables `:root` al inicio de `styles.css`.',
          '- Textos: cada página es HTML autocontenido y legible.',
          '- Imágenes: sustituye las URLs `/api/assets/...` por tus propios archivos (o borra el `<img>`; el degradado `.wf-media` mantiene el diseño).',
        ].join('\n'),
    '',
    '## Sistema de diseño',
    `- Paleta: ${plan.designSystem.paletteName} — fondo ${plan.designSystem.bg}, superficie ${plan.designSystem.surface}, primario ${plan.designSystem.primary}, acento ${plan.designSystem.accent}.`,
    `- Tipografía: títulos ${plan.designSystem.headingFont}; cuerpo ${plan.designSystem.bodyFont}.`,
    `- Motion: ${plan.designSystem.motion} (respeta prefers-reduced-motion).`,
    '',
    '## Procedencia y licencias (transparencia)',
    'El código de este sitio fue escrito íntegramente por OE AI (sin copia de repos). Referencias de diseño consultadas:',
    refs || '- Ninguna (diseño propio).',
    '',
    '## Validación automática',
    checkLines,
    '',
    '— OE AI Web Factory · OE BUSINESS',
  ].join('\n')
}

/* ── Pipeline ─────────────────────────────────────────────────────────────── */

export async function runWebFactory(input: {
  brief: string
  sessionId: string
  existingProjectId?: string
  signal?: AbortSignal
}): Promise<Omit<FactoryResult, 'id' | 'previewUrl' | 'latencyMs'> & { planJson: string; readme: string }> {
  const start = Date.now()
  const isUpdate = Boolean(input.existingProjectId)

  // Modo edición: cargar proyecto existente.
  let existing: { title: string; files: Array<{ path: string; content: string }> } | null = null
  if (input.existingProjectId) {
    const project = await db.buildProject.findUnique({
      where: { id: input.existingProjectId },
      select: { title: true, files: { select: { path: true, content: true } } },
    })
    if (!project) throw new WebFactoryError('El sitio a modificar no existe o fue eliminado.', 'no_files')
    existing = { title: project.title, files: project.files.map((f) => ({ path: f.path, content: f.content })) }
  }

  let plan: FactoryPlan
  if (!existing) {
    // 1) Plan con catálogo real (HyperUI + HugoBlox Kit + GitHub)
    const [refs, componentKinds] = await Promise.all([pickReferences(input.brief), listComponentKinds()])
    const planStart = Date.now()
    const planRes = await buildChatJson<RawPlan>(
      plannerSystemPrompt(),
      plannerUserPrompt(input.brief, refs, componentKinds, null),
      input.signal,
    )
    plan = parsePlan(planRes.data, refs)
    console.error(`[web-factory] plan ${((Date.now() - planStart) / 1000).toFixed(1)}s vía ${planRes.core} · ${plan.pages.length} páginas · framework ${plan.framework} · ${plan.references.length} referencias`)
  } else {
    // Plan mínimo heredado del proyecto existente (para README/procedencia).
    const wasReact = existing.files.some((f) => f.path.startsWith('src/'))
    plan = {
      title: existing.title,
      summary: s('', 'Sitio actualizado con OE AI Web Factory.', 400),
      siteType: 'sitio web',
      aesthetic: 'consistente con el diseño existente',
      framework: wasReact ? 'react' : 'html',
      designSystem: {},
      pages: existing.files.filter((f) => f.path.endsWith('.html')).map((f) => ({
        path: f.path,
        title: f.path.replace('.html', ''),
        sections: [],
      })),
      interactions: [],
      images: [],
      references: [],
    }
  }

  let files: Array<{ path: string; content: string }>
  let images: Array<{ slot: string; assetId: string; url: string }> = []

  if (!existing) {
    // 2) Shell compartido (styles.css + app.js | components/site.tsx)
    const shellStart = Date.now()
    const shellKeys = plan.framework === 'react' ? { css: '', tsx: '' } : { css: '', js: '' }
    const shell = await buildChatJson<{ css?: unknown; js?: unknown; tsx?: unknown }>(
      shellSystemPrompt(plan.framework),
      [
        `Sistema de diseño:\n${JSON.stringify(plan.designSystem)}`,
        `Interacciones pedidas: ${plan.interactions.join('; ') || 'menú móvil y reveal al scroll'}.`,
        plan.framework === 'react'
          ? `Páginas del sitio (para el Navbar/Footer): ${plan.pages.map((p) => `${pageModule(p).route} → "${p.title}"`).join(', ')}. Nombre del sitio: ${plan.title}.`
          : '',
      ].filter(Boolean).join('\n\n'),
      input.signal,
    )
    const css = s(shell.data.css, '', 60_000)
    if (plan.framework === 'react') {
      const siteTsx = s(shell.data.tsx, '', 45_000)
      const cssOk = /@import\s+["']tailwindcss["']/.test(css) || css.includes('--wf-bg')
      const tsxOk = siteTsx.includes('export function Navbar') && siteTsx.includes('export function Footer') && siteTsx.includes('useHashRoute')
      if (!cssOk || !tsxOk) {
        throw new WebFactoryError('El shell React generado no cumplió el contrato mínimo.', 'invalid_plan')
      }
      files = [
        ...reactScaffold(plan),
        { path: 'src/styles.css', content: css },
        { path: 'src/components/site.tsx', content: siteTsx },
      ]
    } else {
      const js = s(shell.data.js, '', 30_000)
      if (!css.includes('--wf-bg') || !js.includes('addEventListener')) {
        throw new WebFactoryError('El shell generado no cumplió el contrato mínimo.', 'invalid_plan')
      }
      files = [
        { path: 'styles.css', content: css },
        { path: 'app.js', content: js },
      ]
    }
    console.error(`[web-factory] shell ${((Date.now() - shellStart) / 1000).toFixed(1)}s vía ${shell.core} · css ${css.length}B · ${plan.framework}`)

    // 3) Imágenes (best-effort, en paralelo)
    images = await generatePlanImages(input.sessionId, plan.images)

    // 4) Páginas (comparten el shell → coherencia). Arranque escalonado para no
    //    golpear el núcleo con todas las peticiones a la vez, y UN reintento por
    //    página fallida: es la fase más cara y perder una página no debe tirar
    //    todo el sitio (causa raíz histórica del error no_files).
    const planJson = JSON.stringify(plan)
    const imageSlots = plan.images.map((i) => i.slot)
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const buildPageOnce = async (page: FactoryPage): Promise<string | null> => {
      try {
        const res = await buildChatJson<{ html?: unknown; tsx?: unknown }>(
          pageSystemPrompt(plan.framework),
          pageUserPrompt(planJson, page, plan.pages, imageSlots, plan.framework),
        )
        const raw = plan.framework === 'react' ? s(res.data.tsx, '', 90_000) : s(res.data.html, '', 90_000)
        if (!raw) return null
        if (plan.framework === 'react') {
          // Contrato TSX: export default function PascalCase(…
          const name = pageModule(page).name
          const reDefault = new RegExp(`export\\s+default\\s+function\\s+${name}\\b`)
          const anyDefault = /export\s+default\s+function\s+\w+/.test(raw)
          return reDefault.test(raw) ? raw : anyDefault ? raw.replace(/export\s+default\s+function\s+(\w+)/, `export default function ${name}`) : null
        }
        return /<html/i.test(raw) ? raw : null
      } catch (err) {
        console.error(`[web-factory] página ${page.path} falló: ${err instanceof Error ? err.message : 'sin detalle'}`)
        return null
      }
    }
    const pageSources = await Promise.all(
      plan.pages.map(async (page, i) => {
        if (i > 0) await sleep(Math.min(i * 1200, 4000))
        let src = await buildPageOnce(page)
        if (!src) {
          await sleep(2500)
          src = await buildPageOnce(page)
          if (src) console.error(`[web-factory] página ${page.path} recuperada en el reintento`)
        }
        return { page, src }
      }),
    )
    if (plan.framework === 'react') {
      const okModules: Array<{ route: string; name: string; title: string }> = []
      for (const { page, src } of pageSources) {
        if (!src) continue
        const mod = pageModule(page)
        files.push({ path: mod.file, content: injectImages(src, images) })
        okModules.push({ route: mod.route, name: mod.name, title: page.title })
      }
      if (okModules.length === 0) {
        throw new WebFactoryError('Ninguna página se pudo componer. Inténtalo de nuevo.', 'no_files')
      }
      // App.tsx determinista con SOLO las páginas que existan.
      files.push({ path: 'src/App.tsx', content: reactAppSource(plan, okModules) })
      const failedPages = pageSources.filter((p) => !p.src).length
      if (failedPages > 0) console.error(`[web-factory] ${failedPages} página(s) fallaron; se entregan ${okModules.length}`)
    } else {
      for (const { page, src } of pageSources) {
        if (src) files.push({ path: page.path, content: injectImages(stripExternalAssets(src), images) })
      }
      const okPages = files.filter((f) => f.path.endsWith('.html')).length
      if (okPages === 0) {
        throw new WebFactoryError('Ninguna página se pudo componer. Inténtalo de nuevo.', 'no_files')
      }
      const failedPages = pageSources.filter((p) => !p.src).length
      if (failedPages > 0) console.error(`[web-factory] ${failedPages} página(s) fallaron; se entregan ${okPages}`)
    }
  } else {
    // Modo edición: una llamada con el contexto completo.
    const res = await buildChatJson<{ summary?: unknown; files?: unknown }>(
      updaterSystemPrompt(plan.framework),
      [
        `Sitio: ${existing.title}`,
        `Archivos actuales:\n${existing.files.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 9000)}`).join('\n\n').slice(0, 60_000)}`,
        `Petición del usuario:\n"""\n${input.brief.slice(0, 2500)}\n"""`,
        'Devuelve el JSON con los archivos completos modificados.',
      ].join('\n\n'),
      input.signal,
    )
    const changed = Array.isArray(res.data.files)
      ? (res.data.files as Array<{ path?: unknown; content?: unknown }>)
          .map((f) => ({
            path:
              (plan.framework === 'react' ? sanitizeReactPath(f.path) : sanitizePagePath(f.path)) ??
              (typeof f.path === 'string' && /^(styles\.css|app\.js|README\.md)$/.test(f.path) ? f.path : null),
            content: typeof f.content === 'string' ? f.content : '',
          }))
          .filter((f): f is { path: string; content: string } => Boolean(f.path) && f.content.trim().length > 0)
          .slice(0, 5)
      : []
    if (changed.length === 0) throw new WebFactoryError('El editor no produjo cambios utilizables.', 'no_files')
    files = changed.map((f) => ({ path: f.path, content: plan.framework === 'react' ? injectImages(f.content, images) : injectImages(stripExternalAssets(f.content), images) }))
    plan.summary = s(res.data.summary, plan.summary, 400)
  }

  // Límite de archivos
  if (files.length > MAX_FILES) files = files.slice(0, MAX_FILES)

  // 5) Validación honesta (puede autofijar metadatos/alt). En proyectos React:
  //    además, verificación REAL — se instalan las dependencias y se compila
  //    (bun install + tsc --noEmit + vite build) en un directorio temporal.
  let realBuild: Awaited<ReturnType<typeof verifyReactBuild>> | undefined
  if (plan.framework === 'react') {
    const filesToVerify = isUpdate
      ? [...(existing?.files ?? []).filter((f) => !files.some((c) => c.path === f.path)), ...files]
      : files
    const vbStart = Date.now()
    realBuild = await verifyReactBuild(filesToVerify)
    // Paso de corrección: si los tipos fallan en archivos que entregamos,
    // el núcleo los reescribe y se re-verifica UNA vez.
    if (realBuild.typecheck.status === 'revisado' && realBuild.errors.length > 0) {
      const repaired = await repairReactFiles(plan, files, realBuild.errors)
      if (repaired > 0) {
        const filesAfterRepair = isUpdate
          ? [...(existing?.files ?? []).filter((f) => !files.some((c) => c.path === f.path)), ...files]
          : files
        realBuild = await verifyReactBuild(filesAfterRepair)
        console.error(`[web-factory] re-verificación tras reparar ${repaired} archivo(s) · tsc ${realBuild.typecheck.status} · build ${realBuild.compile.status}`)
      }
    }
    console.error(`[web-factory] verificación real ${((Date.now() - vbStart) / 1000).toFixed(1)}s · install ${realBuild.install.status} · tsc ${realBuild.typecheck.status} · build ${realBuild.compile.status}`)
  }
  const { checks, warnings } = validateSite({ files, framework: plan.framework, realBuild })

  // 6) README determinista con procedencia y licencias
  files = files.filter((f) => f.path !== 'README.md')
  files.push({ path: 'README.md', content: buildReadme(plan, files.map((f) => f.path), checks) })

  return {
    title: plan.title,
    summary: plan.summary,
    mode: 'web',
    framework: plan.framework,
    stack: plan.framework === 'react' ? 'React 18 · TypeScript · Vite · Web Factory' : 'HTML · CSS · JS · Web Factory',
    isUpdate,
    changedPaths: files.map((f) => f.path),
    files,
    designSystem: plan.designSystem,
    references: plan.references,
    checks,
    warnings: warnings.slice(0, 12),
    images: images.map(({ slot, assetId, url }) => ({ slot, assetId, url })),
    planJson: JSON.stringify(plan),
    readme: '',
    // latencia la calcula el llamador
    ...({ latencyMs: Date.now() - start } as object),
  }
}

export { languageFromPath }
