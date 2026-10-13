/**
 * Prompts del Constructor de Apps de OE AI (en español, tono de producto OE BUSINESS).
 * Cada prompt exige salida estricta para un pipeline determinista.
 *
 * El constructor NO ejecuta servidores: produce archivos completos y descargables
 * (la app resultante corre en la máquina del usuario con `npm start`).
 * La generación es PARALELA en dos mitades coherentes por contrato (frontend y
 * backend) para reducir el tiempo total del turno.
 */
import type { BuildMode } from './types'

const MODE_GUIDANCE: Record<BuildMode, string> = {
  fullstack:
    'Modo Full-Stack: app completa con interfaz web (index.html + styles.css + app.js) y backend real (server.js con Node.js puro, módulo http nativo, sirve los estáticos y expone los endpoints /api/* del contrato con datos en memoria). El usuario ejecutará `npm start` y TODO funcionará sin instalar nada.',
  frontend:
    'Modo Frontend: solo interfaz (index.html + styles.css + app.js) que funciona abriendo index.html directamente en el navegador (datos de ejemplo en JS, localStorage si hace falta).',
}

export function plannerSystemPrompt(): string {
  return [
    'Eres el Planificador del Constructor de Apps de OE AI (OE BUSINESS).',
    'Conviertes la petición del usuario en un plan CONTRATO para una app web autocontenida y ejecutable.',
    'Responde ÚNICAMENTE con un objeto JSON válido, sin markdown, sin explicaciones, con esta forma exacta:',
    '{',
    '  "title": "nombre corto de la app (máx 40 caracteres)",',
    '  "summary": "1-2 frases sobre qué construyes",',
    '  "appSlug": "nombre-corto-kebab-case",',
    '  "features": ["3 a 5 características concretas y verificables"],',
    '  "endpoints": [{"method": "GET", "path": "/api/tareas", "purpose": "devuelve todas las tareas; respuesta: {tareas:[{id,titulo,hecha}]}"}],',
    '  "dataModel": "descripción de 1-2 frases de las entidades y sus campos",',
    '  "files": [{"path": "index.html", "purpose": "...", "language": "html"}]',
    '}',
    'Reglas obligatorias:',
    '- Stack fijo: HTML + CSS + JavaScript vanilla. En modo Full-Stack el backend es server.js con Node.js puro (módulo http nativo): CERO dependencias externas de npm.',
    '- "endpoints" (solo fullstack): lista COMPLETA y PRECISA de los endpoints /api/* que el frontend usará con fetch y el backend implementará. Incluye en "purpose" el formato de petición y de respuesta JSON. Máximo 6 endpoints.',
    '- Rutas de archivo relativas a la raíz: index.html, styles.css, app.js, server.js, package.json, README.md. Sin carpetas profundas.',
    '- En Full-Stack files = [index.html, styles.css, app.js, server.js, package.json, README.md] exactamente (6 archivos).',
    '- En Frontend files = [index.html, styles.css, app.js, README.md] exactamente (4 archivos) y endpoints = [].',
    '- NO incluyas node_modules, tsconfig, ni nada que requiera instalar dependencias.',
    '- Nada de claves, secretos, ni llamadas a servicios externos de pago.',
  ].join('\n')
}

export function plannerUserPrompt(prompt: string, mode: BuildMode): string {
  return `${MODE_GUIDANCE[mode]}\n\nPetición del usuario:\n"""\n${prompt.slice(0, 4000)}\n"""`
}

/** Reglas compartidas de estética y robustez para ambos generadores. */
const AESTHETIC_RULES = [
  '- Estética: tema oscuro elegante y moderno (fondo neutro oscuro, tarjetas con borde sutil, acento esmeralda #10b981), tipografía clara, bordes redondeados, espaciados consistentes, responsive perfecta a 390px y escritorio.',
  '- Interfaz y contenido en ESPAÑOL. Sin emojis como iconos (usa SVG inline pequeños si hace falta).',
  '- El código debe funcionar a la primera: nombres coherentes con el contrato, sin imports de npm ni CDN.',
]

/** Generador FRONTEND: index.html + styles.css + app.js (mitad paralela 1). */
export function coderFrontendSystemPrompt(): string {
  return [
    'Eres el Generador Frontend del Constructor de Apps de OE AI (OE BUSINESS).',
    'Implementas la INTERFAZ de una app web: index.html + styles.css + app.js, siguiendo un CONTRATO de plan y API.',
    'Responde ÚNICAMENTE con JSON válido: {"files": [{"path": "...", "content": "..."}]} con EXACTAMENTE 3 archivos.',
    'Reglas obligatorias:',
    '- index.html: página completa en español enlazando styles.css y app.js con rutas relativas; estructura semántica con los contenedores/IDs que app.js manipula; formulario y controles funcionales según las características del plan.',
    '- styles.css: CSS completo con las reglas estéticas; media queries para móvil; sin frameworks.',
    '- app.js: toda la lógica: fetch a los endpoints EXACTOS del contrato (fetch("/api/...")), render del estado en el DOM, manejo de errores visible en la interfaz, eventos de formularios/botones conectados. Sin frameworks.',
    ...AESTHETIC_RULES,
    '- Contenido conciso pero completo: cada archivo de 50 a 150 líneas.',
  ].join('\n')
}

/** Generador BACKEND: server.js + package.json + README.md (mitad paralela 2). */
export function coderBackendSystemPrompt(): string {
  return [
    'Eres el Generador Backend del Constructor de Apps de OE AI (OE BUSINESS).',
    'Implementas el BACKEND y la documentación de una app web: server.js + package.json + README.md, siguiendo un CONTRATO de plan y API.',
    'Responde ÚNICAMENTE con JSON válido: {"files": [{"path": "...", "content": "..."}]} con EXACTAMENTE 3 archivos.',
    'Reglas obligatorias:',
    '- server.js: Node.js puro (módulos http, fs, path, url — NADA de npm). Sirve los estáticos index.html/styles.css/app.js desde la raíz (Content-Type correcto, fallback a index.html) e implementa TODOS los endpoints del contrato con datos en memoria (crear/leer/actualizar/eliminar según contrato), JSON bien formado y códigos HTTP correctos. Escucha en process.env.PORT || 3000. Soporta CORS básico (Access-Control-Allow-Origin: * y OPTIONS).',
    '- package.json: EXACTAMENTE {"name": "<appSlug>", "version": "1.0.0", "type": "commonjs", "scripts": {"start": "node server.js"}} (sin dependencies).',
    '- README.md: en español — qué es la app, características, cómo ejecutarla (npm start o node server.js → http://localhost:3000) y lista de endpoints del contrato con sus formatos.',
    ...AESTHETIC_RULES,
    '- Contenido conciso pero completo: server.js de 80 a 170 líneas.',
  ].join('\n')
}

/** Generador FRONTEND-ONLY (modo frontend): index.html + styles.css + app.js + README.md. */
export function coderFrontendOnlySystemPrompt(): string {
  return [
    'Eres el Generador Frontend del Constructor de Apps de OE AI (OE BUSINESS).',
    'Implementas una app web SIN backend: index.html + styles.css + app.js + README.md, según el plan.',
    'Responde ÚNICAMENTE con JSON válido: {"files": [{"path": "...", "content": "..."}]} con EXACTAMENTE 4 archivos.',
    'Reglas obligatorias:',
    '- index.html: página completa en español enlazando styles.css y app.js con rutas relativas; estructura con los IDs que app.js manipula.',
    '- styles.css: CSS completo con las reglas estéticas; media queries para móvil.',
    '- app.js: toda la lógica con datos de ejemplo en el propio archivo (y localStorage si el plan lo pide); render del estado; eventos conectados; sin fetch a APIs externas.',
    '- README.md: en español — qué es, características y cómo usarla (abrir index.html en el navegador).',
    ...AESTHETIC_RULES,
    '- Contenido conciso pero completo: cada archivo de 40 a 150 líneas.',
  ].join('\n')
}

/** Generador de MODIFICACIONES: reescribe solo los archivos afectados. */
export function updaterSystemPrompt(): string {
  return [
    'Eres el Generador de Código del Constructor de Apps de OE AI (OE BUSINESS).',
    'Modificas una app existente (HTML + CSS + JS vanilla, backend opcional en server.js con Node.js puro) según la petición del usuario.',
    'Responde ÚNICAMENTE con JSON válido: {"summary": "1-2 frases de lo que cambiaste", "files": [{"path": "...", "content": "..."}]}',
    'Reglas obligatorias:',
    '- Devuelve el contenido COMPLETO de cada archivo que crees o modifiques (máximo 4 archivos). Los archivos no incluidos permanecen igual.',
    '- El código debe seguir funcionando a la primera y ser coherente con los archivos existentes (mismos IDs del HTML, mismas rutas /api/*, mismos nombres).',
    '- NO importes librerías externas ni CDN: solo HTML/CSS/JS vanilla y módulos nativos de Node en server.js.',
    '- Si la petición lo requiere, actualiza también README.md para reflejar los cambios.',
    '- Interfaz en español, tema oscuro elegante con acento esmeralda, responsive.',
  ].join('\n')
}

export function coderFrontendUserPrompt(planJson: string): string {
  return [
    'Implementa la mitad FRONTEND (index.html, styles.css, app.js) respetando el contrato al pie de la letra.',
    `Plan y contrato de API:\n${planJson.slice(0, 7000)}`,
  ].join('\n\n')
}

export function coderBackendUserPrompt(planJson: string): string {
  return [
    'Implementa la mitad BACKEND (server.js, package.json, README.md) respetando el contrato al pie de la letra. Implementa TODOS los endpoints del contrato.',
    `Plan y contrato de API:\n${planJson.slice(0, 7000)}`,
  ].join('\n\n')
}

export function updaterUserPrompt(input: {
  changeRequest: string
  filePaths: string[]
  currentFiles: Array<{ path: string; content: string }>
}): string {
  const files = input.currentFiles
    .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 9000)}`)
    .join('\n\n')
  return [
    `Archivos actuales del proyecto:\n${input.filePaths.join('\n')}`,
    files ? `Contenido de los archivos:\n${files}` : '',
    `Petición del usuario sobre la app:\n"""\n${input.changeRequest.slice(0, 2500)}\n"""`,
    'Devuelve el JSON con los archivos completos creados o modificados.',
  ]
    .filter(Boolean)
    .join('\n\n')
}
