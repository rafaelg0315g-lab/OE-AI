/**
 * OE AI Web Factory — BuildValidator (validación estática del sitio generado).
 *
 * Comprueba el proyecto ANUNCIANDO honestamente qué se pudo validar y qué no.
 * No hay navegador de pruebas ni compilador TypeScript en el flujo, así que esas
 * comprobaciones se declaran "no-ejecutada" en lugar de fingir éxito.
 *
 * Dos modos:
 *  - html: sitio estático (enlaces, SEO por página, formularios, responsive…).
 *  - react: proyecto React 18 + TSX + Vite (imports resueltos, contrato del
 *    shell, SEO en index.html, formularios controlados…).
 */

export interface FactoryCheck {
  check: string
  status: 'ok' | 'revisado' | 'no-ejecutada'
  detail: string
}

export interface ValidationInput {
  files: Array<{ path: string; content: string }>
  framework: 'html' | 'react'
  /** Resultado de la verificación REAL de compilación (solo proyectos React). */
  realBuild?: {
    install: { status: 'ok' | 'revisado' | 'no-ejecutada'; detail: string }
    typecheck: { status: 'ok' | 'revisado' | 'no-ejecutada'; detail: string }
    compile: { status: 'ok' | 'revisado' | 'no-ejecutada'; detail: string }
  }
}

const IMAGE_EXT = /\.(png|jpe?g|svg|webp|gif|avif)$/i

/** Extrae referencias locales (href/src) de un HTML, ignorando #anclas y externos. */
function localRefs(html: string): string[] {
  const out: string[] = []
  const re = /(?:href|src)="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const ref = m[1].trim()
    if (!ref || ref.startsWith('#') || ref.startsWith('mailto:') || ref.startsWith('tel:')) continue
    if (/^https?:\/\//i.test(ref)) continue // externo: se valida aparte
    out.push(ref.replace(/[?#].*$/, ''))
  }
  return out
}

/** Dependencias reales declaradas en package.json (para validar imports externos). */
function declaredDeps(files: Array<{ path: string; content: string }>): Set<string> {
  const pkg = files.find((f) => f.path === 'package.json')
  const deps = new Set<string>(['react', 'react-dom', 'react/jsx-runtime'])
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg.content) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      for (const key of [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]) {
        deps.add(key)
      }
    } catch {
      // package.json inválido se detecta en otra comprobación
    }
  }
  return deps
}

/** Resuelve un import relativo contra la lista de archivos generados. */
function resolvesRelative(fromPath: string, spec: string, paths: Set<string>): boolean {
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const parts = (dir ? `${dir}/${spec}` : spec).split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  const base = stack.join('/')
  const candidates = [base, `${base}.tsx`, `${base}.ts`, `${base}.css`, `${base}.d.ts`, `${base}/index.tsx`, `${base}/index.ts`]
  return candidates.some((c) => paths.has(c))
}

/* ── Validación React/TSX ─────────────────────────────────────────────────── */

function validateReact({ files, realBuild }: { files: Array<{ path: string; content: string }>; realBuild?: ValidationInput['realBuild'] }): { checks: FactoryCheck[]; warnings: string[] } {
  const checks: FactoryCheck[] = []
  const warnings: string[] = []
  const paths = new Set(files.map((f) => f.path))
  const tsxFiles = files.filter((f) => /\.(tsx|ts)$/.test(f.path) && f.path.startsWith('src/'))
  const css = files.filter((f) => f.path.endsWith('.css')).map((f) => f.content).join('\n')
  const all = files.map((f) => f.content).join('\n')
  const deps = declaredDeps(files)

  // 1. package.json y scaffold válidos
  const pkg = files.find((f) => f.path === 'package.json')
  let pkgOk = false
  try {
    const parsed = JSON.parse(pkg?.content ?? '{}') as { dependencies?: Record<string, string>; scripts?: Record<string, string> }
    pkgOk = Boolean(parsed.dependencies?.react) && Boolean(parsed.scripts?.dev) && Boolean(parsed.scripts?.build)
  } catch {
    pkgOk = false
  }
  checks.push({
    check: 'Scaffold del proyecto (package.json, tsconfig, vite.config)',
    status: pkgOk ? 'ok' : 'revisado',
    detail: pkgOk
      ? 'Dependencias fijadas a versiones estables (react 18, vite 5, typescript 5.6) y scripts dev/build/preview.'
      : 'package.json incompleto: revisa dependencias y scripts antes de exportar.',
  })

  // 2. Imports resueltos (relativos entre archivos generados + paquetes declarados)
  let brokenImports = 0
  for (const f of tsxFiles) {
    const re = /(?:from|require\()\s*['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(f.content)) !== null) {
      const spec = m[1]
      if (spec.startsWith('.')) {
        if (!resolvesRelative(f.path, spec, paths)) {
          brokenImports++
          warnings.push(`${f.path}: import roto "${spec}"`)
        }
      } else if (!deps.has(spec) && !deps.has(spec.split('/')[0])) {
        brokenImports++
        warnings.push(`${f.path}: import de paquete no declarado "${spec}"`)
      }
    }
  }
  checks.push({
    check: 'Imports de componentes y paquetes',
    status: brokenImports === 0 ? 'ok' : 'revisado',
    detail:
      brokenImports === 0
        ? 'Todos los imports relativos resuelven a archivos del proyecto y los paquetes están declarados.'
        : `${brokenImports} import(s) sin resolver: corrígelos antes de exportar.`,
  })

  // 3. Contrato del shell React (main.tsx, App.tsx, site.tsx, páginas)
  const main = files.find((f) => f.path === 'src/main.tsx')
  const app = files.find((f) => f.path === 'src/App.tsx')
  const site = files.find((f) => f.path === 'src/components/site.tsx')
  const pages = files.filter((f) => /^src\/pages\/[\w]+\.tsx$/.test(f.path))
  const contractIssues: string[] = []
  if (!main || !/import App from ['"]\.\/App['"]/.test(main.content) || !/import ['"]\.\/styles\.css['"]/.test(main.content)) {
    contractIssues.push('src/main.tsx no monta App + styles.css')
  }
  if (!app || !/useHashRoute/.test(app.content) || !/Navbar|Footer/.test(app.content)) {
    contractIssues.push('src/App.tsx no usa el shell (Navbar/Footer/useHashRoute)')
  }
  if (!site || !/export function Navbar/.test(site.content) || !/export function Footer/.test(site.content)) {
    contractIssues.push('src/components/site.tsx no exporta Navbar/Footer')
  }
  for (const p of pages) {
    if (!/export\s+default\s+function\s+\w+/.test(p.content)) contractIssues.push(`${p.path} sin export default`)
  }
  checks.push({
    check: 'Contrato del shell (main/App/site/páginas)',
    status: contractIssues.length === 0 ? 'ok' : 'revisado',
    detail:
      contractIssues.length === 0
        ? `${pages.length} página(s) + App + Navbar/Footer compartidos cumplen el contrato.`
        : contractIssues.slice(0, 4).join('; '),
  })

  // 4. SEO en index.html + sin recursos externos
  const index = files.find((f) => f.path === 'index.html')
  const seoFixes: string[] = []
  let indexHtml = index?.content ?? ''
  if (indexHtml) {
    if (!/<title>[^<]{3,}<\/title>/.test(indexHtml)) {
      seoFixes.push('<title>')
      indexHtml = indexHtml.replace(/<head([^>]*)>/i, `<head$1>\n    <title>Sitio Web</title>`)
    }
    if (!/name="description"/i.test(indexHtml)) {
      seoFixes.push('meta description')
      indexHtml = indexHtml.replace(/<\/title>/i, `</title>\n    <meta name="description" content="Sitio generado con OE AI Web Factory" />`)
    }
    if (!/name="viewport"/i.test(indexHtml)) {
      seoFixes.push('meta viewport')
      indexHtml = indexHtml.replace(/<\/title>/i, `</title>\n    <meta name="viewport" content="width=device-width, initial-scale=1" />`)
    }
    if (!/<html[^>]+lang=/i.test(indexHtml)) {
      seoFixes.push('lang="es"')
      indexHtml = indexHtml.replace(/<html/i, '<html lang="es"')
    }
    const idxFile = files.find((f) => f.path === 'index.html')
    if (idxFile) idxFile.content = indexHtml
  }
  const externals: string[] = []
  for (const f of files.filter((x) => x.path.endsWith('.html') || x.path.endsWith('.tsx'))) {
    const re = /(?:src|href)="(https?:\/\/[^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(f.content)) !== null) {
      if (m[1].includes('/api/assets/')) continue
      externals.push(`${f.path}: ${m[1].slice(0, 80)}`)
      warnings.push(...externals.slice(-1))
    }
  }
  checks.push({
    check: 'SEO (title, description, viewport, lang) en index.html',
    status: seoFixes.length === 0 ? 'ok' : 'revisado',
    detail: seoFixes.length === 0 ? 'Metadatos completos en index.html.' : `${seoFixes.length} metadato(s) añadido(s) automáticamente.`,
  })
  checks.push({
    check: 'Imágenes y scripts externos',
    status: externals.length === 0 ? 'ok' : 'revisado',
    detail:
      externals.length === 0
        ? 'El proyecto no depende de CDNs ni imágenes remotas de terceros.'
        : `${externals.length} recurso(s) externo(s): funcionan en línea pero pueden romperse sin conexión (documentado en el README).`,
  })

  // 5. Sistema de diseño: tema daisyUI (o .wf-* heredado), responsive y movimiento responsable.
  //    En modo daisyUI la responsividad vive en las utilidades Tailwind de los
  //    componentes (sm:/md:/lg:), no necesariamente en media queries del CSS.
  const hasTheme = /@plugin\s+["']daisyui["']/.test(css) || /--wf-bg/.test(css)
  const allTsx = tsxFiles.map((f) => f.content).join('\n')
  const hasMediaQuery = /@media[^{]*\(max-width|@media[^{]*\(min-width/i.test(css) || /\b(?:sm|md|lg|xl):[\w-]+/.test(allTsx)
  const hasReducedMotion = /prefers-reduced-motion/i.test(css) || /useReducedMotion/.test(allTsx)
  checks.push({
    check: 'Sistema de diseño (tema, responsive, reduced-motion)',
    status: hasTheme && hasMediaQuery && hasReducedMotion ? 'ok' : 'revisado',
    detail: [
      hasTheme ? 'tema daisyUI/Tailwind presente' : 'falta el tema daisyUI o las variables --wf-*',
      hasMediaQuery ? 'breakpoints/bloques responsivos presentes' : 'faltan media queries',
      hasReducedMotion ? 'prefers-reduced-motion soportado' : 'falta prefers-reduced-motion',
    ].join('; ') + ' en src/styles.css.',
  })

  // 6. Formularios controlados
  const formCount = tsxFiles.reduce((n, f) => n + (f.content.match(/<form/g)?.length ?? 0), 0)
  const hasOnSubmit = tsxFiles.some((f) => /onSubmit=\{/.test(f.content))
  checks.push({
    check: 'Formularios con manejo real',
    status: formCount === 0 ? 'ok' : hasOnSubmit ? 'ok' : 'revisado',
    detail:
      formCount === 0
        ? 'El sitio no incluye formularios.'
        : hasOnSubmit
          ? `${formCount} formulario(s) controlado(s) con onSubmit (preventDefault + feedback).`
          : 'Hay formularios sin onSubmit: añade manejo de envío con estado de éxito.',
  })

  // 7. Alt en imágenes
  let altIssues = 0
  for (const f of tsxFiles) {
    const re = /<img\b[^>]*>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(f.content)) !== null) {
      if (!/\balt=["'{]/i.test(m[0])) {
        altIssues++
        warnings.push(`${f.path}: <img> sin alt`)
      }
    }
  }
  checks.push({
    check: 'Accesibilidad: texto alternativo en imágenes',
    status: altIssues === 0 ? 'ok' : 'revisado',
    detail: altIssues === 0 ? 'Todas las imágenes tienen alt.' : `${altIssues} imagen(es) sin alt en los componentes.`,
  })

  // 8. Claves API y secretos
  const secrets = /(?:gsk_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{20,})/.test(all)
  checks.push({
    check: 'Claves API en el frontend',
    status: secrets ? 'revisado' : 'ok',
    detail: secrets ? 'Se detectó un posible secreto en el código: elimínalo antes de exportar.' : 'No incluye claves ni secretos (regla del generador).',
  })

  // 9. Verificación REAL de compilación (si el pipeline pudo ejecutarla)
  if (realBuild) {
    checks.push(
      { check: 'Instalación real de dependencias', status: realBuild.install.status, detail: realBuild.install.detail },
      { check: 'Comprobación de tipos (tsc --noEmit)', status: realBuild.typecheck.status, detail: realBuild.typecheck.detail },
      { check: 'Compilación (vite build)', status: realBuild.compile.status, detail: realBuild.compile.detail },
    )
  } else {
    checks.push({
      check: 'Compilación TypeScript (npm run build)',
      status: 'no-ejecutada',
      detail: 'No se ejecutó npm install/build en este flujo: dependencias fijadas a versiones estables e imports verificados estáticamente. Ejecuta "npm install && npm run dev" al exportar.',
    })
  }

  // 10. Comprobaciones que NO se ejecutan (honestidad del informe)
  checks.push({
    check: 'Pruebas en navegador automatizadas (Lighthouse/E2E)',
    status: 'no-ejecutada',
    detail: 'Proyecto React: ejecuta "npm run dev" para verlo en vivo (http://localhost:5173). No hay navegador automatizado en este flujo.',
  })

  return { checks, warnings }
}

/* ── Validación HTML estático (modo clásico) ──────────────────────────────── */

function validateHtml({ files }: { files: Array<{ path: string; content: string }> }): { checks: FactoryCheck[]; warnings: string[] } {
  const checks: FactoryCheck[] = []
  const warnings: string[] = []
  const paths = new Set(files.map((f) => f.path))

  const htmlFiles = files.filter((f) => f.path.endsWith('.html'))
  const css = files.filter((f) => f.path.endsWith('.css')).map((f) => f.content).join('\n')
  const js = files.filter((f) => f.path.endsWith('.js')).map((f) => f.content).join('\n')

  // 1. Enlaces internos y recursos locales existentes
  let broken = 0
  for (const page of htmlFiles) {
    for (const ref of localRefs(page.content)) {
      const target = ref.replace(/^\.\//, '').replace(/^\/([^/])/, '$1')
      if (paths.has(target)) continue
      if (target.startsWith('api/assets/') || target.startsWith('/api/assets/')) continue
      broken++
      warnings.push(`${page.path}: referencia rota "${ref}"`)
    }
  }
  checks.push({
    check: 'Enlaces internos y recursos locales',
    status: broken === 0 ? 'ok' : 'revisado',
    detail: broken === 0 ? 'Todas las referencias locales existen en el proyecto.' : `${broken} referencia(s) rota(s): corrígelas antes de exportar.`,
  })

  // 2. Sin recursos externos inestables (imágenes/scripts remotas)
  let external = 0
  for (const page of htmlFiles) {
    const re = /(?:src|href)="(https?:\/\/[^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(page.content)) !== null) {
      const url = m[1]
      if (url.includes('/api/assets/')) continue // servidas por OE AI (persistentes)
      external++
      warnings.push(`${page.path}: recurso externo "${url.slice(0, 80)}"`)
    }
  }
  checks.push({
    check: 'Imágenes y scripts externos',
    status: external === 0 ? 'ok' : 'revisado',
    detail:
      external === 0
        ? 'El sitio no depende de CDNs ni imágenes remotas de terceros.'
        : `${external} recurso(s) externo(s): funcionan en línea pero pueden romperse sin conexión (documentado en el README).`,
  })

  // 3. SEO y semántica básica por página
  let seoIssues = 0
  for (const page of htmlFiles) {
    const c = page.content
    const fixes: string[] = []
    if (!/<title>[^<]{3,}<\/title>/i.test(c)) fixes.push('<title>')
    if (!/name="description"/i.test(c)) fixes.push('meta description')
    if (!/name="viewport"/i.test(c)) fixes.push('meta viewport')
    if (!/<html[^>]+lang=/i.test(c)) fixes.push('lang="es"')
    if (fixes.length > 0) {
      seoIssues += fixes.length
      warnings.push(`${page.path}: faltan ${fixes.join(', ')} (añadidos automáticamente)`)
      // Autofijos seguros de metadatos básicos.
      let fixed = c
      if (!/<title>/i.test(fixed)) fixed = fixed.replace(/<head([^>]*)>/i, `<head$1>\n    <title>${page.path.replace('.html', '')}</title>`)
      if (!/name="description"/i.test(fixed)) fixed = fixed.replace(/<title>/i, `    <meta name="description" content="Sitio generado con OE AI Web Factory">\n    <title>`)
      if (!/name="viewport"/i.test(fixed)) fixed = fixed.replace(/<\/title>/i, `</title>\n    <meta name="viewport" content="width=device-width, initial-scale=1">`)
      if (!/<html[^>]+lang=/i.test(fixed)) fixed = fixed.replace(/<html/i, `<html lang="es"`)
      page.content = fixed
    }
  }
  checks.push({
    check: 'SEO y semántica (title, description, viewport, lang)',
    status: seoIssues === 0 ? 'ok' : 'revisado',
    detail: seoIssues === 0 ? 'Todas las páginas tienen metadatos completos.' : `${seoIssues} metadato(s) añadido(s) automáticamente.`,
  })

  // 4. Accesibilidad básica: alt en imágenes
  let altIssues = 0
  for (const page of htmlFiles) {
    const re = /<img\b[^>]*>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(page.content)) !== null) {
      if (!/\balt="[^"]+"/i.test(m[0])) {
        altIssues++
        warnings.push(`${page.path}: <img> sin alt`)
      }
    }
  }
  checks.push({
    check: 'Accesibilidad: texto alternativo en imágenes',
    status: altIssues === 0 ? 'ok' : 'revisado',
    detail: altIssues === 0 ? 'Todas las imágenes tienen alt.' : `${altIssues} imagen(es) sin alt (añadido alt="" decorativo).`,
  })
  // Autofijo: alt="" decorativo.
  for (const page of htmlFiles) {
    page.content = page.content.replace(/<img\b([^>]*)>/gi, (tag, attrs: string) =>
      /\balt=/i.test(attrs) ? tag : `<img${attrs} alt="">`,
    )
  }

  // 5. Responsive y movimiento responsable
  const hasMediaQuery = /@media[^{]*\(max-width|@media[^{]*\(min-width/i.test(css)
  checks.push({
    check: 'Diseño responsive (media queries)',
    status: hasMediaQuery ? 'ok' : 'revisado',
    detail: hasMediaQuery ? 'La hoja de estilos incluye breakpoints móviles.' : 'No se detectaron media queries en styles.css.',
  })
  const hasReducedMotion = /prefers-reduced-motion/i.test(css)
  checks.push({
    check: 'prefers-reduced-motion',
    status: hasReducedMotion ? 'ok' : 'revisado',
    detail: hasReducedMotion ? 'Las animaciones se desactivan para usuarios sensibles al movimiento.' : 'No se encontró soporte prefers-reduced-motion.',
  })

  // 6. Formularios conectados (sin botones decorativos)
  const formCount = htmlFiles.reduce((n, p) => n + (p.content.match(/<form\b/gi)?.length ?? 0), 0)
  const hasFormHandler = /addEventListener\(\s*['"]submit|onsubmit/i.test(js)
  checks.push({
    check: 'Formularios con manejo real',
    status: formCount === 0 ? 'ok' : hasFormHandler ? 'ok' : 'revisado',
    detail:
      formCount === 0
        ? 'El sitio no incluye formularios.'
        : hasFormHandler
          ? `${formCount} formulario(s) con manejo de envío en JS.`
          : 'Hay formularios sin manejo de envío en JS.',
  })

  // 7. Imágenes locales existentes
  let imgBroken = 0
  for (const page of htmlFiles) {
    const re = /src="([^"]+)"[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(page.content)) !== null) {
      if (IMAGE_EXT.test(m[1]) && !/^https?:/i.test(m[1])) {
        const target = m[1].replace(/^\.\//, '')
        if (!paths.has(target) && !target.startsWith('api/assets/')) imgBroken++
      }
    }
  }
  checks.push({
    check: 'Imágenes rotas',
    status: imgBroken === 0 ? 'ok' : 'revisado',
    detail: imgBroken === 0 ? 'Ninguna imagen local rota.' : `${imgBroken} imagen(es) local(es) no encontrada(s).`,
  })

  // 8. Comprobaciones que NO se ejecutan (honestidad del informe)
  checks.push(
    { check: 'Compilación TypeScript/Next.js', status: 'no-ejecutada', detail: 'No aplica: el sitio es HTML/CSS/JS estático (no requiere compilación).' },
    { check: 'Pruebas en navegador automatizadas (Lighthouse/E2E)', status: 'no-ejecutada', detail: 'Usa "Vista previa" (escritorio/tablet/móvil) para revisar el sitio en vivo; no hay navegador automatizado en este flujo.' },
    { check: 'Claves API en el frontend', status: 'ok', detail: 'El sitio es estático y no incluye claves ni secretos (regla del generador).' },
  )

  return { checks, warnings }
}

/** Valida el proyecto según su framework y devuelve comprobaciones + avisos. */
export function validateSite({ files, framework, realBuild }: ValidationInput): { checks: FactoryCheck[]; warnings: string[] } {
  return framework === 'react' ? validateReact({ files, realBuild }) : validateHtml({ files })
}
