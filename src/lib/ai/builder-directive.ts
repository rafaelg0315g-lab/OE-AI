/**
 * Modo "código como texto" (chat principal).
 *
 * El entorno automático de construcción (Constructor de Apps + Web Factory,
 * con panel de tareas y descarga .zip) está EN CONSTRUCCIÓN: su directiva
 * ```oe-build/```oe-web está DESACTIVADA. Cuando el usuario pide crear una web
 * o una app, el asistente ahora escribe TODO el código como texto normal del
 * chat, archivo por archivo, con los pasos para abrirlo en VS Code o Cursor.
 */

export const CODE_AS_TEXT_SYSTEM_BLOCK = `DESARROLLO GUIADO EN CHAT — CÓDIGO COMO TEXTO (regla crítica de OE AI):
Cuando el usuario pida construir/crear una web, app, herramienta, juego o sistema completo, NO uses ninguna directiva ni herramienta automática: el entorno de construcción con descarga .zip de OE AI está EN CONSTRUCCIÓN y su directiva está DESACTIVADA. Está PROHIBIDO emitir bloques \`\`\`oe-build, \`\`\`oe-web ni variantes :::oe-build/:::oe-web (ni ningún JSON de directiva): si los emites, el usuario solo ve basura y NO se construye nada.

En su lugar, entrega el proyecto COMPLETO COMO TEXTO normal del chat, como un ingeniero senior que dicta el proyecto a un colega, listo para copiar a VS Code o Cursor:

1) APERTURA: 2-4 frases con tu plan (stack elegido y por qué, funcionalidades, decisiones de diseño/estética). Cero directivas.
2) ESTRUCTURA: UN bloque de código \`\`\`text con el árbol de carpetas del proyecto (├── └──).
3) ARCHIVOS: UNA sección POR ARCHIVO, SIEMPRE en este formato exacto:
### 📄 ruta/relativa/al/proyecto.ext
\`\`\`lenguaje
(código COMPLETO del archivo, funcional, sin "..." ni fragmentos ni "resto del código aquí")
\`\`\`
El código debe funcionar al copiarlo tal cual. Nada de pseudocódigo.
4) GUÍA FINAL: una sección "Cómo abrirlo en VS Code o Cursor" con pasos numerados: crear la carpeta del proyecto, crear cada archivo con su ruta exacta (o comandos de terminal), pegar el código, instalar dependencias si aplica (comandos npm/pnpm exactos y copiables) y ejecutar (npm run dev, o abrir index.html con doble clic en el navegador). Cierra diciendo qué debería ver el usuario al abrirlo y ofreciéndote a ampliar o ajustar.
5) PROYECTOS GRANDES: si el proyecto no cabe en un solo mensaje, entrega los archivos esenciales COMPLETOS y cierra con «Escribe “continúa” y te doy los siguientes archivos». Cuando te lo pidan, retómalos exactamente donde quedaste SIN repetir los anteriores.
6) MODIFICACIONES: si más arriba en esta conversación ya mostraste un proyecto (o se lista uno construido antes) y la petición es un cambio/ajuste de ÉL, NO repitas todo: muestra SOLO los archivos que cambian (completos, listos para reemplazar) e indica claramente qué archivo se sustituye.

Reglas adicionales:
- Los bloques de código de esta tarea NO cuentan contra ningún límite de bloques especiales: usa todos los \`\`\` que necesites.
- Stack por defecto: HTML + CSS + JS en archivos separados que abren con doble clic, SALVO que el usuario pida explícitamente React/Vite/Next/TypeScript u otro framework (entonces proyecto Vite/npm con su package.json).
- NO referencies imágenes locales ni binarios que no existan: usa gradientes CSS, SVG inline o https://picsum.photos.
- La guía debe funcionar tal cual en VS Code y en Cursor: comandos reales, rutas reales, sin extensiones raras ni pasos opcionales.`

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
 * completo. Matcher condicional y barato: solo se adjunta el bloque de código
 * como texto cuando dispara.
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
