/**
 * Detección de intención de MEDIOS en el mensaje del usuario (chat natural).
 *
 * El usuario no debe necesitar pulsar ningún botón: si escribe "crea una imagen
 * de un gato astronauta" o "genera un icono SVG de un cohete", el chat interpreta
 * la intención y ejecuta la herramienta correspondiente en el mismo turno.
 *
 * Reglas de formato (política del producto):
 * - "SVG" explícito → se genera código SVG real (vectorial, escalable).
 * - "icono/icon/logo" (sin SVG) → imagen PNG en estilo icono (cuadrada).
 * - "imagen/ilustración/foto/dibujo…" → imagen PNG estándar.
 * - Los iconos son PNG por defecto; SVG solo cuando se pide explícitamente.
 */

export type MediaFormat = 'image' | 'icon' | 'svg'

export interface MediaIntent {
  /** Formato con el que se producirá el activo. */
  format: MediaFormat
  /** Sujeto limpio de la petición (sin el verbo ni "una imagen de"). */
  subject: string
  /** Prompt final para el generador (sujeto + guía de estilo si aplica). */
  prompt: string
  /** Tamaño solicitado al generador de imágenes (PNG). Ignorado en SVG. */
  size: '1024x1024' | '768x1344' | '1344x768'
}

/** Verbos de creación (español + inglés), con y sin acentos. Incluye débiles
 * coloquiales ("quiero una imagen de…", "dame un logo de…", "hazme un dibujo…"). */
const CREATE_VERB =
  /\b(crea|crea[rme]|creáme|creame|créame|genera|genera[rme]|genérame|generame|haz|hazme|hacer|dibuja|dibuja[rme]|dibújame|dibujame|pinta|pinta[rme]|píntame|pintame|ilustra|ilustrame|ilústrame|dise[ñn]a|dise[ñn]a[rme]|dise[ñn]ame|imagine|imagina|inventa|convierte|transforma|renderiza|renderízame|renderizame|quiero|quisiera|deseo|necesito|dame|make|create|generate|draw|design|paint|render|give me|i want)\b/i

/** Objetos que disparan la generación (palabra clave + contexto). */
const MEDIA_OBJECT =
  /\b(un[ao]?\s+|el|la|los|las\s+)?(imagen|imágenes|imagenes|ilustraci[óo]n|ilustraciones|fotograf[íi]as?|foto|fotos|picture|picsum|dibujo|dibujos|wallpaper|fondo de pantalla|fondos?|poster|p[óo]ster|banner|portada|logo|logotipo|icono|[íi]cono|icon|pictograma|avatar|emblema|escudo|insignia|svg|arte|artwork|vector|sticker|pegatina|mascota|spinner|favicon|retrato|retratos|caricatura|caricaturas|mockup|maqueta|flyer|cartel|afiche|miniatura|thumbnail|tatuaje|tattoo|mural|pintura|monograma|pixel art|concept art|emote)\b/i

/** Solo mensajes cortos e imperativos: evita secuestrar conversaciones largas
 * que mencionan imágenes de pasada (p. ej. "anoche vi una imagen de…"). */
const MAX_INTENT_CHARS = 240

/** Conectores que quedan entre "imagen" y el sujeto ("una imagen DE un gato"). */
const LEADING_CONNECTOR = /^[\s:,;—–-]*(de|del|sobre|acerca de|para|que muestre|que represente|con tema|of|about|showing|with|for)\s+/i

/** Palabras de formato que NO deben quedar dentro del sujeto ("SVG de un cohete" → "un cohete"). */
const LEADING_FORMAT_WORD = /^(svg|png|jpe?g|webp|gif|icono|[íi]cono|icon|logo|logotipo|pictograma|vectorial|vector)[\s,:;—–-]+/i

/** Detecta orientación pedida para la imagen (PNG). La vertical manda: si el
 * mensaje la menciona aunque también haya "banner/wallpaper", gana vertical. */
function detectSize(message: string, format: MediaFormat): MediaIntent['size'] {
  if (format === 'icon') return '1024x1024'
  const t = message.toLowerCase()
  if (/vertical|m[óo]vil|historia|story|reel|9:16/.test(t)) return '768x1344'
  if (/horizontal|panor[áa]mic|banner|portada|wallpaper|escritorio|16:9/.test(t)) return '1344x768'
  return '1024x1024'
}

/**
 * Analiza el mensaje y devuelve la intención de medios, o null si el mensaje
 * NO es una petición de generación (preguntas y charla normal quedan intactas).
 */
export function detectMediaIntent(rawMessage: string): MediaIntent | null {
  const message = rawMessage.trim()
  if (!message || message.length > MAX_INTENT_CHARS) return null

  const objectMatch = MEDIA_OBJECT.exec(message)
  if (!objectMatch) return null

  // El verbo debe aparecer ANTES (o muy cerca) del objeto: "crea una imagen…",
  // "un icono SVG de…" (imperativo elíptico también vale).
  const beforeObject = message.slice(0, objectMatch.index)
  const afterObject = message.slice(objectMatch.index + objectMatch[0].length)
  const verbInPrefix = CREATE_VERB.test(beforeObject)
  const startsWithObject = objectMatch.index === 0
  if (!verbInPrefix && !startsWithObject) return null

  // Formato: SVG solo explícito; icono/logo → PNG estilo icono; resto imagen.
  const explicitSvg = /\bsvg\b/i.test(message)
  const isIconWord = /\b(icono|[íi]cono|icon|pictograma|logo|logotipo|emblema|insignia|favicon|mascota|sticker|spinner|avatar|emote)\b/i.test(message)
  const format: MediaFormat = explicitSvg ? 'svg' : isIconWord ? 'icon' : 'image'

  // Sujeto: lo que sigue al objeto; si es vacío, lo que sigue al verbo.
  // Se limpian conectores ("de", "para") y palabras de formato residual
  // ("png", "svg", "logo"…) para no contaminar el prompt del generador.
  const cleanSubject = (raw: string): string => {
    let s = raw
    for (let i = 0; i < 4; i++) {
      s = s.replace(LEADING_FORMAT_WORD, '').replace(LEADING_CONNECTOR, '').replace(/^[\s.,;:—–-]+/, '')
    }
    return s.replace(/[\s.!?¡¿]+$/, '').trim()
  }
  let subject = cleanSubject(afterObject)
  if (subject.length < 3) {
    const verbMatch = CREATE_VERB.exec(beforeObject)
    if (verbMatch) {
      subject = cleanSubject(beforeObject.slice(verbMatch.index + verbMatch[0].length).replace(MEDIA_OBJECT, ''))
    }
  }
  if (subject.length < 3) subject = message // sin sujeto claro: el mensaje completo guía

  const size = detectSize(message, format)
  const prompt =
    format === 'icon'
      ? `${subject} — icono flat minimalista, estilo vectorial, trazos limpios, centrado, alto contraste, fondo liso y simple`
      : subject

  return { format, subject, prompt, size }
}

/* ── Contexto y referencias web para el enriquecimiento del prompt ───────── */

/** Sujeto vago que apunta a la conversación ("del tema", "eso que hablamos").
 * Cuando dispara, el backend resuelve el tema real con el historial reciente. */
export function isContextualSubject(subject: string): boolean {
  return /\b(tema|esto|eso|aquello|lo anterior|lo de arriba|lo que (hablamos|comentamos|dijimos?|dije)|misma idea|conversaci[óo]n|contexto|ese tema|este tema|esa idea|esta idea|lo mismo)\b/i.test(
    subject,
  )
}

/** Petición que menciona marcas/lugares/realidad: activa la búsqueda de
 * referencias reales en la web para inyectarlas en el prompt ("colocar marcas
 * y más, todo lo que esté en la web"). */
export const WEB_GROUND_RE =
  /\b(marca|logotipo|logo|branding|brand|empresa|negocio|franquicia|producto|lugar|edificio|monumento|ciudad|pa[íi]s|bandera|uniforme|equipo|selecci[óo]n|celebridad|artista|banda|grupo musical|personaje real|de la web|de internet|en la web|fiel a la realidad|que sea real)\b/i

/* ── Intención de GALERÍA: ver imágenes REALES de la web (no crear) ──────── */

/** Verbos de búsqueda/visualización (ver lo que ya existe en la web). */
const SEARCH_VERB =
  /\b(busca|b[úu]scame|busca[rme]|buscar|muestrame|mu[eé]strame|ens[eé][ñn]ame|tr[aá]eme|traeme|encuentra|encuentrame|encu[eé]ntrame|find|show me|search(?: for)?|looking for)\b/i

/** Objetos de búsqueda visual: imágenes/fotos existentes (NO icono/svg/logo). */
const SEARCH_OBJECT =
  /\b(im[áa]genes?|imagenes?|fotos?|fotograf[íi]as?|pictures?|pics|photos?|fotograf[ií]as)\b/i

/** Verbos de creación FUERTES: si están, el usuario QUIERE generar (no buscar).
 * Los débiles ("quiero/dame/deseo…") NO bloquean la galería: "quiero imágenes de
 * París" sigue siendo búsqueda web; "quiero UNA imagen de París" (singular, sin
 * verbo de búsqueda) cae en generación por el orden del router. */
const STRONG_CREATE_VERB =
  /\b(crea|crea[rme]|creáme|creame|créame|genera|genera[rme]|genérame|generame|haz|hazme|hacer|dibuja|dibuja[rme]|dibújame|dibujame|pinta|pinta[rme]|p[íi]ntame|pintame|ilustra|ilustrame|ilústrame|dise[ñn]a|dise[ñn]a[rme]|dise[ñn]ame|convierte|transforma|renderiza|renderízame|renderizame|inventa|make|create|generate|draw|design|paint|render)\b/i

export interface GalleryIntent {
  /** Tema del que buscar imágenes (para la directiva del system prompt). */
  subject: string
}

/**
 * Detecta peticiones de VER imágenes reales de la web ("busca fotos de…",
 * "muéstrame imágenes de…", "imágenes de arquitectura brutalista…").
 * Devuelve null si el mensaje es de generación (verbos de creación), si no
 * menciona imágenes/fotos o si es conversación normal: entonces el turno
 * sigue siendo chat o generación de medios según el orden del router.
 */
export function detectGalleryIntent(rawMessage: string): GalleryIntent | null {
  const message = rawMessage.trim()
  if (!message || message.length > MAX_INTENT_CHARS) return null
  if (STRONG_CREATE_VERB.test(message)) return null

  const objectMatch = SEARCH_OBJECT.exec(message)
  if (!objectMatch) return null

  const searchVerb = SEARCH_VERB.test(message)
  const startsWithObject = objectMatch.index === 0
  // Verbos débiles de deseo ("quiero/dame/necesito imágenes de…"): cuenta como
  // búsqueda SI el objeto es plural y NO va precedido de artículo indefinido
  // ("quiero UNA imagen de París" es generación de una imagen).
  const beforeObject = message.slice(0, objectMatch.index)
  const weakDesireSearch =
    /\b(quiero|quisiera|deseo|necesito|dame|pasame|pásame)\b/i.test(beforeObject) &&
    !/\b(un|una)\s+$/i.test(beforeObject) &&
    /\b(im[áa]genes|imagenes|fotos|fotograf[íi]as|pictures|pics|photos)\b/i.test(message.slice(objectMatch.index))
  if (!searchVerb && !startsWithObject && !weakDesireSearch) return null

  // Sujeto: lo que sigue al objeto ("imágenes DE arquitectura brutalista").
  let subject = message.slice(objectMatch.index + objectMatch[0].length)
  subject = subject
    .replace(/^[\s:,;—–-]*(de|del|sobre|acerca de|con tema de|of|about)\s+/i, '')
    .replace(/^[\s.,;:—–-]+/, '')
    .replace(/[\s.!?¡¿]+$/, '')
    .trim()
  if (subject.length < 3) subject = message
  return { subject: subject.slice(0, 200) }
}
