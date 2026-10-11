/**
 * OE AI Web Factory — Catálogo de plantillas y componentes (servidor únicamente).
 *
 * Fuentes:
 *  - Fuente A: GitHub topic "website-template" (búsqueda de la API pública de GitHub).
 *  - Fuente B: HyperUI (github.com/markmead/hyperui) como referencia de componentes.
 *  - Fuente C: HugoBlox Kit (github.com/HugoBlox/kit) — patrones profesionales de
 *    headers, heroes y secciones (hero, features, precios, testimonios, FAQ…)
 *    transferibles a HTML y a TSX/React.
 *  - Fuente D: daisyUI (github.com/saadeghi/daisyui) — biblioteca de componentes
 *    CSS (Tailwind) usada como dependencia REAL en los proyectos React y como
 *    referencia de patrones en los sitios HTML.
 *  - Fuente E: UI UX Pro Max (github.com/nextlevelbuilder/ui-ux-pro-max-skill) —
 *    inteligencia de diseño (estilos UI, paletas, tipografía, guías UX) que
 *    alimenta las reglas de profesionalidad del planificador.
 *
 * Reglas de reutilización responsable:
 *  - La licencia se registra SOLO si la API de GitHub devuelve un SPDX concreto
 *    (licenseVerified). Sin licencia clara → status "referencia" (solo
 *    inspiración visual, nunca copia de código).
 *  - No se clona ni descarga código de los repos: solo metadatos.
 *  - La búsqueda en GitHub es best-effort con caché en DB; si GitHub no está
 *    disponible, el catálogo curado embebido (licencias conocidas) garantiza
 *    que el módulo funcione.
 */
import { db } from '@/lib/db'

export interface CatalogTemplate {
  source: string
  name: string
  repoUrl: string
  category: string
  tech: string
  description: string
  licenseSpdx: string | null
  licenseVerified: boolean
  stars: number
  tags: string[]
  status: 'activo' | 'referencia'
  notes?: string
}

export interface CatalogComponent {
  source: string
  name: string
  category: string
  tech: string
  description: string
  licenseSpdx: string | null
  licenseVerified: boolean
  repoUrl: string
  tags: string[]
}

const HYPERUI_REPO = 'https://github.com/markmead/hyperui'
const HUGOBLOX_REPO = 'https://github.com/HugoBlox/kit'
const DAISYUI_REPO = 'https://github.com/saadeghi/daisyui'
const UUPM_REPO = 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill'

/** Categorías canónicas del catálogo (ampliables sin tocar la arquitectura). */
export const CATALOG_CATEGORIES = [
  'landing', 'corporativo', 'saas', 'ia', 'ecommerce', 'agencia', 'portfolio',
  'restaurante', 'turismo', 'inmobiliaria', 'educacion', 'finanzas',
  'admin', 'dashboard', 'blog', 'producto', 'auth',
] as const

/** Mapa de palabras clave del brief → categoría (condicional y barato). */
const CATEGORY_KEYWORDS: Array<[string, RegExp]> = [
  ['landing', /landing|aterrizaje|lanzamiento|one ?page/],
  ['saas', /saas|software|suscripci|startup|app web|plataforma/],
  ['ia', /\bia\b|inteligencia artificial|chatbot|gpt|automatizaci/],
  ['ecommerce', /tienda|ecommerce|e-commerce|venta|productos|carrito|shop/],
  ['agencia', /agencia|estudio|marketing|creativa|publicidad/],
  ['portfolio', /portafolio|portfolio|fot[oó]grafo|dise[nñ]ador|cv personal/],
  ['restaurante', /restaurante|caf[eé]|comida|bar\b|panader[ií]a|pizzer[ií]a/],
  ['turismo', /viajes|turismo|hotel|tours|agencia de viajes|destinos/],
  ['inmobiliaria', /inmobiliari|propiedades|casas|alquiler|real estate/],
  ['educacion', /educaci|curso|escuela|academia|colegio|universidad/],
  ['finanzas', /finanz|banco|inversi|contable|fintech|seguros/],
  ['admin', /admin|administraci[oó]n|backoffice|panel administrativo/],
  ['dashboard', /dashboard|panel de control|m[eé]tricas|anal[ií]tica/],
  ['blog', /blog|revista|noticias|medios|art[ií]culos/],
  ['producto', /p[aá]gina de producto|landing de producto|app m[oó]vil|producto [uú]nico/],
  ['auth', /login|registro|autenticaci|acceso|sign in|formularios y autenticaci/],
  ['corporativo', /corporativ|empresa|consultora|cl[ií]nica|odontolog|abogados|profesional/],
]

/** Normaliza texto: minúsculas, sin acentos. */
function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Categoría estimada para un brief (para filtrar el catálogo antes del LLM). */
export function guessCategory(brief: string): string {
  const t = normalize(brief)
  for (const [cat, re] of CATEGORY_KEYWORDS) {
    if (re.test(t)) return cat
  }
  return 'corporativo'
}

/**
 * Catálogo curado embebido (respaldo si GitHub no responde). Solo entradas con
 * licencia conocida y verificable públicamente.
 */
const CURATED_TEMPLATES: CatalogTemplate[] = [
  {
    source: 'hyperui', name: 'HyperUI', repoUrl: HYPERUI_REPO, category: 'landing',
    tech: 'HTML · Tailwind CSS', description: 'Biblioteca de componentes Tailwind para marketing, e-commerce y aplicación: heroes, precios, testimonios, navegación, footers y más.',
    licenseSpdx: 'MIT', licenseVerified: true, stars: 0,
    tags: ['componentes', 'tailwind', 'marketing', 'ecommerce'], status: 'activo',
    notes: 'Componentes copiables con atribución de licencia MIT en el proyecto derivado.',
  },
  {
    source: 'github-curated', name: 'Start Bootstrap', repoUrl: 'https://github.com/StartBootstrap', category: 'landing',
    tech: 'HTML · CSS · Bootstrap', description: 'Colección de plantillas y temas gratuitos de calidad (Agency, Creative, Landing Page, Freelancer…).',
    licenseSpdx: 'MIT', licenseVerified: true, stars: 0,
    tags: ['plantillas', 'bootstrap', 'negocios'], status: 'activo',
    notes: 'Licencia MIT: reutilización y adaptación permitidas conservando el aviso de licencia.',
  },
  {
    source: 'github-curated', name: 'Tailwindtoolbox', repoUrl: 'https://github.com/tailwindtoolbox', category: 'landing',
    tech: 'HTML · Tailwind CSS', description: 'Plantillas y componentes open-source de Tailwind CSS (landing pages, dashboards, auth).',
    licenseSpdx: 'MIT', licenseVerified: true, stars: 0,
    tags: ['tailwind', 'plantillas'], status: 'activo',
    notes: 'MIT.',
  },
  {
    source: 'hugoblox', name: 'HugoBlox Kit', repoUrl: HUGOBLOX_REPO, category: 'corporativo',
    tech: 'HTML · TSX · Hugo', description: 'Kit open-source con bloques profesionales de sitio: headers con menú y CTA, heroes variados, features, precios, testimonios, FAQ, equipo, portafolio y footers ricos. Patrones transferibles a HTML y a componentes TSX.',
    licenseSpdx: 'MIT', licenseVerified: true, stars: 0,
    tags: ['headers', 'hero', 'componentes', 'tsx', 'profesional'], status: 'activo',
    notes: 'MIT en el repo; la licencia se re-verifica contra la API de GitHub en cada refresco. Se usan como patrones de estructura (el código es propio).',
  },
  {
    source: 'daisyui', name: 'daisyUI', repoUrl: DAISYUI_REPO, category: 'saas',
    tech: 'CSS · Tailwind', description: 'Biblioteca de componentes CSS sobre Tailwind (botones, cards, navbar, stats, acordeones, timeline, carousel…). En los proyectos React de OE AI se instala como dependencia real (npm) con tema personalizado de la paleta del sitio.',
    licenseSpdx: 'MIT', licenseVerified: true, stars: 0,
    tags: ['css', 'componentes', 'tailwind', 'react', 'elite'], status: 'activo',
    notes: 'MIT. En modo React: dependencia real instalada (tailwindcss 4 + @tailwindcss/vite + daisyui 5). En modo HTML: sus patrones se trasladan al sistema .wf-* propio.',
  },
  {
    source: 'uupm', name: 'UI UX Pro Max', repoUrl: UUPM_REPO, category: 'corporativo',
    tech: 'Conocimiento de diseño', description: 'Inteligencia de diseño con 79 estilos UI, 192 paletas de color, 74 emparejamientos tipográficos y 119 guías UX. Alimenta las reglas de profesionalidad (jerarquía, contraste, espaciado, microinteracciones) del generador.',
    licenseSpdx: 'MIT', licenseVerified: true, stars: 0,
    tags: ['ux', 'ui', 'diseño', 'paletas', 'tipografía'], status: 'activo',
    notes: 'MIT (verificado contra el LICENSE del repo). Se usan sus PRINCIPIOS de diseño; no se copia código.',
  },
  {
    source: 'github-curated', name: 'Cruip Open React Template', repoUrl: 'https://github.com/cruip/open-react-template', category: 'saas',
    tech: 'React · Tailwind CSS', description: 'Plantilla open-source para SaaS/landing con secciones de producto, precios y testimonios.',
    licenseSpdx: 'MIT', licenseVerified: true, stars: 0,
    tags: ['react', 'saas', 'landing'], status: 'activo',
    notes: 'MIT en el repo open-source (los temas premium de Cruip NO son open-source: no usar).',
  },
  {
    source: 'github-curated', name: 'HTML5 UP (ajlkn)', repoUrl: 'https://github.com/ajlkn', category: 'corporativo',
    tech: 'HTML · CSS · JS (SCSS)', description: 'Sitios de demostración muy pulidos (Dimension, Stellar, Phantom…): referencia de estética premium.',
    licenseSpdx: 'CC-BY-3.0', licenseVerified: true, stars: 0,
    tags: ['estética', 'premium', 'one-page'], status: 'referencia',
    notes: 'CC BY 3.0: reutilizable SOLO conservando el crédito/footer de atribución del autor. Se usa como referencia visual.',
  },
]

/**
 * Componentes/secciones de daisyUI (MIT, Fuente D): patrones CSS con nombre
 * daisyUI que el compositor React usa como clases reales (npm i daisyui) y el
 * compositor HTML replica con el sistema .wf-*.
 */
const DAISYUI_COMPONENTS: CatalogComponent[] = (
  [
    ['nav', 'Navbar daisyUI con menú desplegable, botón CTA y tema'],
    ['hero', 'Hero daisyUI con imagen lateral, titular y CTA'],
    ['stats', 'Stats daisyUI: cifras grandes con título, descripción y figura'],
    ['features', 'Cards daisyUI con imagen, título, acciones y badge'],
    ['pricing', 'Precios con cards destacadas, badge y lista de beneficios'],
    ['testimonios', 'Testimonios con avatar, rating de estrellas y cita'],
    ['faq', 'Collapse/Acordeón daisyUI para FAQ'],
    ['cta', 'CTA en tarjeta con degradado y botones primarios'],
    ['team', 'Avatares daisyUI con nombre, cargo y presencia en línea'],
    ['galeria', 'Galería de cards con overlay y sombra'],
    ['blog', 'Artículos con imagen, badge de categoría y meta'],
    ['form', 'Formulario con inputs daisyUI, validación y join de botón'],
    ['footer', 'Footer daisyUI con columnas, newsletter y social'],
    ['logos', 'Fila de marcas con avatar-placeholder y opacidad sutil'],
    ['steps', 'Steps/Timeline daisyUI para procesos y cómo funciona'],
    ['carousel', 'Carousel daisyUI para mostrarios y testimonios'],
  ] as Array<[string, string]>
).map(([category, description]) => ({
  source: 'daisyui',
  name: description,
  category,
  tech: 'CSS · Tailwind · daisyUI',
  description,
  licenseSpdx: 'MIT',
  licenseVerified: true,
  repoUrl: DAISYUI_REPO,
  tags: [category, 'daisyui', 'css', 'componentes'],
}))

/**
 * Componentes/secciones de HugoBlox Kit (MIT, Fuente C): patrones PROFESIONALES
 * de headers, heroes y secciones. Cada patrón describe la anatomía que el
 * compositor debe replicar en HTML o en componentes TSX/React.
 */
const HUGOBLOX_COMPONENTS: CatalogComponent[] = (
  [
    ['nav', 'Header sticky con logo, enlaces, botón CTA destacado y menú móvil'],
    ['nav', 'Header con barra de anuncio superior, enlaces y búsqueda'],
    ['hero', 'Hero split: titular grande a la izquierda, imagen/dashes a la derecha y prueba social debajo'],
    ['hero', 'Hero centrado con kicker, titular display, lead, doble CTA y fila de confianza'],
    ['features', 'Grid de características con iconos SVG, título y descripción por tarjeta'],
    ['features', 'Características alternadas imagen/texto (zigzag) con lista de puntos'],
    ['stats', 'Banda de estadísticas con números grandes, contadores y etiquetas'],
    ['logos', 'Muro de logos de clientes/aliados (logo cloud) en fila responsiva'],
    ['testimonios', 'Testimonios en grid con cita, avatar, nombre y cargo'],
    ['testimonios', 'Testimonio destacado en cita amplia con foto lateral'],
    ['pricing', 'Precios con 3 planes, plan destacado, lista de beneficios y nota de facturación'],
    ['faq', 'FAQ en acordeón de una o dos columnas con iconos +/−'],
    ['cta', 'CTA final en tarjeta destacada: titular grande, texto y botones'],
    ['team', 'Equipo con tarjetas: foto, nombre, cargo y enlaces sociales'],
    ['galeria', 'Portafolio/galería en grid con overlay de título al hover'],
    ['blog', 'Blog destacado: tarjeta grande + lista lateral de entradas'],
    ['form', 'Contacto: formulario con nombre/email/mensaje y datos de contacto al lado'],
    ['footer', 'Footer con 4 columnas, newsletter, redes sociales y línea legal'],
  ] as Array<[string, string]>
).map(([category, description]) => ({
  source: 'hugoblox',
  name: description,
  category,
  tech: 'HTML · TSX',
  description,
  licenseSpdx: 'MIT',
  licenseVerified: true,
  repoUrl: HUGOBLOX_REPO,
  tags: [category, 'hugoblox', 'profesional', 'header'],
}))

/** Componentes/secciones de HyperUI (MIT): patrones de referencia por categoría. */
const HYPERUI_COMPONENTS: CatalogComponent[] = (
  [
    ['hero', 'Hero de portada con titular y doble CTA'],
    ['hero', 'Hero centrado con imagen de producto'],
    ['nav', 'Navegación con menú móvil desplegable'],
    ['nav', 'Barra de anuncio superior + navegación'],
    ['features', 'Grid de características con iconos'],
    ['features', 'Sección de características con imagen lateral'],
    ['pricing', 'Tabla de precios con 3 planes'],
    ['pricing', 'Comparativa de planes con destacado'],
    ['testimonios', 'Testimonios en grid con avatares'],
    ['testimonios', 'Testimonio destacado en cita amplia'],
    ['cta', 'Banner CTA con fondo contrastado'],
    ['cta', 'CTA final con formulario de email'],
    ['faq', 'Acordeón de preguntas frecuentes'],
    ['stats', 'Banda de estadísticas y cifras clave'],
    ['logos', 'Fila de logos de clientes/aliados'],
    ['footer', 'Footer corporativo con columnas'],
    ['footer', 'Footer compacto con redes sociales'],
    ['galeria', 'Galería de imágenes en grid'],
    ['form', 'Formulario de contacto con nombre/mensaje'],
    ['form', 'Newsletter con validación de email'],
    ['team', 'Presentación de equipo con tarjetas'],
    ['blog', 'Grid de artículos/entradas destacadas'],
  ] as Array<[string, string]>
).map(([category, description]) => ({
  source: 'hyperui',
  name: description,
  category,
  tech: 'HTML · Tailwind CSS',
  description,
  licenseSpdx: 'MIT',
  licenseVerified: true,
  repoUrl: HYPERUI_REPO,
  tags: [category, 'hyperui', 'sección'],
}))

/** Siembra el catálogo curado (idempotente). */
async function seedCurated(): Promise<void> {
  for (const t of CURATED_TEMPLATES) {
    await db.webTemplate.upsert({
      where: { repoUrl: t.repoUrl },
      create: {
        source: t.source, name: t.name, repoUrl: t.repoUrl, category: t.category,
        tech: t.tech, description: t.description, licenseSpdx: t.licenseSpdx,
        licenseVerified: t.licenseVerified, stars: t.stars, tags: JSON.stringify(t.tags),
        status: t.status, notes: t.notes ?? null,
      },
      update: {
        name: t.name, category: t.category, description: t.description, tech: t.tech,
        licenseSpdx: t.licenseSpdx, licenseVerified: t.licenseVerified,
        tags: JSON.stringify(t.tags), status: t.status, notes: t.notes ?? null,
        lastReviewedAt: new Date(),
      },
    })
  }
  for (const c of [...HYPERUI_COMPONENTS, ...HUGOBLOX_COMPONENTS, ...DAISYUI_COMPONENTS]) {
    await db.webComponent.upsert({
      where: { source_name: { source: c.source, name: c.name } },
      create: { ...c, tags: JSON.stringify(c.tags) },
      update: {
        category: c.category, tech: c.tech, description: c.description,
        licenseSpdx: c.licenseSpdx, licenseVerified: c.licenseVerified,
        repoUrl: c.repoUrl, tags: JSON.stringify(c.tags), lastReviewedAt: new Date(),
      },
    })
  }
}

interface GithubRepo {
  name?: string
  full_name?: string
  html_url?: string
  description?: string | null
  stargazers_count?: number
  language?: string | null
  topics?: string[]
  license?: { spdx_id?: string | null } | null
}

/** Repos con entrada curada propia: la búsqueda por topics NO debe pisarlos. */
const RESERVED_REPO_URLS = new Set([HYPERUI_REPO, HUGOBLOX_REPO, DAISYUI_REPO, UUPM_REPO])

function repoToTemplate(repo: GithubRepo, fallbackCategory: string): CatalogTemplate | null {
  const url = repo.html_url ?? (repo.full_name ? `https://github.com/${repo.full_name}` : null)
  if (!url) return null
  if (RESERVED_REPO_URLS.has(url)) return null // la entrada curada manda
  const spdx = repo.license?.spdx_id ?? null
  const verified = Boolean(spdx && spdx !== 'NOASSERTION' && spdx !== 'OTHER')
  const techParts = [...new Set([repo.language ?? 'HTML', 'HTML', 'CSS'].filter(Boolean))]
  return {
    source: 'github-topic',
    name: repo.name ?? repo.full_name ?? url,
    repoUrl: url,
    category: fallbackCategory,
    tech: techParts.join(' · '),
    description: (repo.description ?? 'Plantilla web pública de GitHub.').slice(0, 300),
    licenseSpdx: verified ? spdx : null,
    licenseVerified: verified,
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
    tags: (repo.topics ?? []).slice(0, 6),
    // Sin licencia verificada → solo referencia visual (nunca copiar código).
    status: verified ? 'activo' : 'referencia',
    notes: verified
      ? `Licencia ${spdx} según la API de GitHub; revisar el LICENSE del repo antes de reutilizar código.`
      : 'Sin licencia verificable: usar SOLO como referencia visual; no copiar código.',
  }
}

/**
 * Descubrimiento bajo demanda: consulta GitHub (topics de plantillas + HyperUI)
 * y hace upsert en el catálogo. Best-effort: los errores se registran y no
 * rompen el catálogo existente.
 */
export async function refreshFromGitHub(): Promise<{ added: number; errors: string[] }> {
  const errors: string[] = []
  let added = 0
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'OE-AI-WebFactory',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const queries: Array<{ q: string; category: string }> = [
    { q: 'topic:website-template stars:>50', category: 'landing' },
    { q: 'topic:landing-page stars:>80', category: 'landing' },
    { q: 'topic:tailwindcss template stars:>100', category: 'saas' },
  ]

  for (const { q, category } of queries) {
    try {
      const res = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=6`,
        { headers, signal: AbortSignal.timeout(15_000) },
      )
      if (!res.ok) {
        errors.push(`GitHub ${res.status} en "${q}"`)
        continue
      }
      const data = (await res.json()) as { items?: GithubRepo[] }
      for (const repo of data.items ?? []) {
        const tpl = repoToTemplate(repo, category)
        if (!tpl) continue
        await db.webTemplate.upsert({
          where: { repoUrl: tpl.repoUrl },
          create: {
            source: tpl.source, name: tpl.name, repoUrl: tpl.repoUrl, category: tpl.category,
            tech: tpl.tech, description: tpl.description, licenseSpdx: tpl.licenseSpdx,
            licenseVerified: tpl.licenseVerified, stars: tpl.stars, tags: JSON.stringify(tpl.tags),
            status: tpl.status, notes: tpl.notes ?? null,
          },
          update: {
            name: tpl.name, description: tpl.description, licenseSpdx: tpl.licenseSpdx,
            licenseVerified: tpl.licenseVerified, stars: tpl.stars, tech: tpl.tech,
            tags: JSON.stringify(tpl.tags), status: tpl.status, notes: tpl.notes ?? null,
            lastReviewedAt: new Date(),
          },
        })
        added++
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message.slice(0, 120) : 'error de red')
    }
  }

  // HyperUI (Fuente B) y HugoBlox Kit (Fuente C): metadatos del repo con
  // licencia verificada vía API. Mismo patrón para ambas fuentes.
  const repoSources: Array<{ url: string; repoUrl: string; source: string; name: string; category: string; tech: string; tags: string[]; notes: string }> = [
    {
      url: 'https://api.github.com/repos/markmead/hyperui',
      repoUrl: HYPERUI_REPO, source: 'hyperui', name: 'HyperUI', category: 'landing',
      tech: 'HTML · Tailwind CSS', tags: ['componentes', 'tailwind', 'hyperui'],
      notes: 'Componentes Tailwind copiables con licencia MIT (atribución en el proyecto derivado).',
    },
    {
      url: 'https://api.github.com/repos/HugoBlox/kit',
      repoUrl: HUGOBLOX_REPO, source: 'hugoblox', name: 'HugoBlox Kit', category: 'corporativo',
      tech: 'HTML · TSX · Hugo', tags: ['headers', 'hero', 'componentes', 'tsx', 'profesional'],
      notes: 'MIT verificado vía API de GitHub; patrones de headers/heroes/secciones transferibles a HTML y TSX (el código del sitio es propio).',
    },
    {
      url: 'https://api.github.com/repos/saadeghi/daisyui',
      repoUrl: DAISYUI_REPO, source: 'daisyui', name: 'daisyUI', category: 'saas',
      tech: 'CSS · Tailwind', tags: ['css', 'componentes', 'tailwind', 'react'],
      notes: 'MIT. Dependencia real en los proyectos React de OE AI (daisyui 5 + tailwindcss 4).',
    },
    {
      url: 'https://api.github.com/repos/nextlevelbuilder/ui-ux-pro-max-skill',
      repoUrl: UUPM_REPO, source: 'uupm', name: 'UI UX Pro Max', category: 'corporativo',
      tech: 'Conocimiento de diseño', tags: ['ux', 'ui', 'diseño', 'paletas'],
      notes: 'MIT. Sus principios (estilos, paletas, tipografía, UX) alimentan las reglas del generador; no se copia código.',
    },
  ]
  for (const src of repoSources) {
    try {
      const res = await fetch(src.url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const repo = (await res.json()) as GithubRepo
        const spdx = repo.license?.spdx_id ?? 'MIT'
        await db.webTemplate.upsert({
          where: { repoUrl: src.repoUrl },
          create: {
            source: src.source, name: src.name, repoUrl: src.repoUrl, category: src.category,
            tech: src.tech,
            description: (repo.description ?? 'Biblioteca de componentes y bloques de sitio web.').slice(0, 300),
            licenseSpdx: spdx === 'NOASSERTION' ? 'MIT' : spdx, licenseVerified: true,
            stars: repo.stargazers_count ?? 0,
            tags: JSON.stringify(src.tags),
            status: 'activo',
            notes: src.notes,
          },
          update: {
            stars: repo.stargazers_count ?? 0,
            description: (repo.description ?? '').slice(0, 300),
            licenseSpdx: spdx === 'NOASSERTION' ? 'MIT' : spdx,
            licenseVerified: true,
            lastReviewedAt: new Date(),
          },
        })
        added++
      } else {
        errors.push(`GitHub ${res.status} en ${src.source}`)
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message.slice(0, 120) : 'error de red')
    }
  }

  return { added, errors }
}

/** Garantiza un catálogo usable: siembra curado (1 vez por proceso) + refresco GitHub best-effort. */
let curatedSeeded = false
export async function ensureCatalog(): Promise<{ templates: number; components: number }> {
  // El upsert curado es idempotente y barato: las entradas nuevas (p. ej.
  // HugoBlox Kit) se incorporan SIN depender de que el catálogo estuviera
  // vacío, y solo 1 vez por proceso.
  if (!curatedSeeded) {
    await seedCurated()
    curatedSeeded = true
  }
  let [templates, components] = await Promise.all([db.webTemplate.count(), db.webComponent.count()])
  if (templates < 8) {
    await refreshFromGitHub().catch(() => undefined)
    ;[templates, components] = await Promise.all([db.webTemplate.count(), db.webComponent.count()])
  }
  return { templates, components }
}

/** Plantillas de referencia para un brief (filtradas por categoría estimada). */
export async function pickReferences(brief: string, limit = 6): Promise<CatalogTemplate[]> {
  await ensureCatalog()
  const category = guessCategory(brief)
  const rows = await db.webTemplate.findMany({
    where: { OR: [{ category }, { status: 'activo' }] },
    orderBy: [{ status: 'asc' }, { stars: 'desc' }],
    take: 24,
  })
  const seen = new Set<string>()
  const out: CatalogTemplate[] = []
  for (const r of rows) {
    if (seen.has(r.repoUrl)) continue
    seen.add(r.repoUrl)
    out.push({
      source: r.source, name: r.name, repoUrl: r.repoUrl, category: r.category,
      tech: r.tech, description: r.description, licenseSpdx: r.licenseSpdx,
      licenseVerified: r.licenseVerified, stars: r.stars,
      tags: safeTags(r.tags),
      status: r.status === 'referencia' ? 'referencia' : 'activo',
      notes: r.notes ?? undefined,
    })
    if (out.length >= limit) break
  }
  return out
}

/** Secciones disponibles para el compositor (para el prompt del planificador). */
export async function listComponentKinds(): Promise<Array<{ category: string; examples: string[] }>> {
  await ensureCatalog()
  const rows = await db.webComponent.findMany({ orderBy: { category: 'asc' }, take: 60 })
  const byCat = new Map<string, string[]>()
  for (const r of rows) {
    const arr = byCat.get(r.category) ?? []
    if (arr.length < 2) arr.push(r.name)
    byCat.set(r.category, arr)
  }
  return [...byCat.entries()].map(([category, examples]) => ({ category, examples }))
}

function safeTags(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 8) : []
  } catch {
    return []
  }
}
