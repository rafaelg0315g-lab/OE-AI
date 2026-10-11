/**
 * Directiva del Constructor de Apps (chat principal).
 *
 * Cuando el usuario pide construir una app completa, el asistente NO escribe
 * el código inline: emite una directiva ```oe-build y el constructor real
 * (POST /api/tools/build-app) genera los archivos completos que el usuario
 * descarga uno a uno o como .zip desde las tarjetas del mensaje.
 */

export const BUILDER_SYSTEM_BLOCK = `CONSTRUCTOR Y WEB FACTORY DE OE AI (importante):
Cuando el usuario pida construir algo, elige la herramienta según lo que pida:

A) OE AI WEB FACTORY — para SITIOS WEB PROFESIONALES (webs de negocios, landings, agencias, clínicas, restaurantes, portafolios, tiendas, hoteles, sitios corporativos o multi-página con secciones de marketing). NO escribas el código: responde 1-2 frases anunciando el concepto del sitio y añade UN bloque de código con etiqueta "oe-web" que contenga EXACTAMENTE este JSON:
\`\`\`oe-web
{"name": "Nombre corto del sitio", "brief": "descripción detallada del sitio: tipo de negocio, secciones deseadas, estética (ej: lujo minimalista, cálido artesanal, tech limpio), páginas y estilo visual. Si el usuario pide React/TSX/Next/Vite explícitamente, indícalo aquí con la frase \"proyecto React con componentes TSX\". En español.", "mode": "web"}
\`\`\`
El Web Factory genera sitios de NIVEL ELITE con headers, heroes, precios, testimonios y FAQ profesionales (patrones de HugoBlox Kit, HyperUI y daisyUI + principios de UI UX Pro Max), ANIMACIONES CSS reales (titulares animados letra a letra, iconos vivos, marquee de logos, orbes, botones con brillo), en HTML multi-página o como proyecto React 18 + TypeScript + Vite (si el usuario pide React/TSX, con daisyUI, Tailwind, framer-motion y lucide-react instalados automáticamente y compilación verificada).

B) CONSTRUCTOR DE APPS — para apps, herramientas, juegos o sistemas con lógica (fullstack o frontend). NO escribas el código: responde 1-2 frases anunciando qué vas a construir y añade UN bloque de código con etiqueta "oe-build" que contenga EXACTAMENTE este JSON:
\`\`\`oe-build
{"name": "Nombre corto de la app", "brief": "descripción detallada de la app a construir: funcionalidades concretas, páginas, endpoints de API necesarios y estilo visual. En español.", "mode": "fullstack"}
\`\`\`

Reglas comunes:
- "brief": mínimo 2 frases con tu diseño (funcionalidades/secciones, datos, endpoints si aplica y estética).
- El constructor generará los archivos reales y el usuario los verá como tarjetas con descarga .zip y vista previa (webs).
- NO escribas tú el código de la app/sitio ni añadas bloques de código aparte: solo las 1-2 frases + la directiva.
- MODIFICACIONES (crítico): si abajo se lista un proyecto ya construido en esta conversación y la petición es un cambio/ajuste de ÉL (estilo, colores, secciones, textos, hero, añadir/quitar algo), es SIEMPRE una MODIFICACIÓN: emite la directiva del MISMO tipo que ese proyecto CON "projectId" (el id listado) y NO escribas código inline ni crees un proyecto nuevo. "Haz el hero más elegante" sobre una web listada = directiva oe-web con ese projectId.
- NO uses directivas para preguntas sobre código, snippets, correcciones o explicaciones: solo para construir algo COMPLETO nuevo o modificar lo ya construido en esta conversación.
- EXCEPCIÓN: si la petición es por voz (conversación hablada), responde con normalidad sin directivas.`

/** Normaliza texto: minúsculas, sin acentos, sin puntuación redundante. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Verbos de construcción (ES/EN). */
const BUILD_VERBS =
  /(crea|crear|creame|hazme|hacer|haz\b|construye|construir|genera|generar|generame|desarrolla|desarrollar|programa\b|programar|hagamos|quiero un[ao]?\b|necesito un[ao]?\b|dame un[ao]?\b|make|build|create|develop|generate|code me)/

/** Sustantivos de producto "app completa" (ES/EN). */
const APP_NOUNS =
  /(app|aplicacion|aplicación|webapp|pagina web|página web|web\b|sitio web|sistema|plataforma|juego|videojuego|herramienta|dashboard|panel de|panel administrativo|crud|landing|marketplace|tienda online|portfolio|blog completo|clon de|gestor de|administrador de|fullstack|full-stack|frontend|backend)/

/** Peticiones explicativas que NO deben disparar la directiva. */
const EXPLANATION_GUARDS =
  /^(como|cómo|que es|qué es|que significa|cuando|cuándo|por que|porqué|porque|dime que es|explicame|explícame|cual es|cuál es|consejos para|tips para|diferencia)/

/**
 * true cuando el mensaje parece una petición de CONSTRUIR una app o sitio web
 * completo. Matcher condicional y barato: solo se adjunta la directiva cuando
 * dispara (el modelo elige luego entre oe-web y oe-build).
 */
export function shouldAttachBuilderDirective(message: string): boolean {
  const t = normalize(message)
  if (t.length < 8) return false
  if (EXPLANATION_GUARDS.test(t)) return false
  if (!APP_NOUNS.test(t)) return false
  // "build/create/construye..." explícito, o un verbo de construcción cerca del sustantivo.
  if (/\b(build|create|crea|hazme|construye|generame|desarrolla)\b/.test(t) && APP_NOUNS.test(t)) return true
  return BUILD_VERBS.test(t) && APP_NOUNS.test(t)
}

/** Palabras que indican SITIO WEB profesional (para preferir oe-web sobre oe-build). */
export function looksLikeWebsiteRequest(message: string): boolean {
  const t = normalize(message)
  return /\b(web|sitio web|landing|pagina web|multi ?pagina|secciones|portafolio|agencia|clinica|restaurante|hotel|tienda online|corporativo)\b/.test(t)
}
