/**
 * Contratos del Constructor de Apps de OE AI (en el chat principal).
 *
 * El asistente emite una directiva ```oe-build y el constructor responde con
 * un proyecto de archivos reales completos (descargables uno a uno o como
 * .zip). Nada se simula: "ready" implica archivos completos guardados en DB.
 */

export const BUILD_MODES = ['fullstack', 'frontend'] as const
export type BuildMode = (typeof BUILD_MODES)[number]

export const BUILD_MODE_LABEL: Record<BuildMode, string> = {
  fullstack: 'Full-Stack',
  frontend: 'Frontend',
}

export function isBuildMode(value: unknown): value is BuildMode {
  return typeof value === 'string' && (BUILD_MODES as readonly string[]).includes(value)
}

/** Plan producido por el planificador del constructor. */
export interface BuildPlan {
  title: string
  summary: string
  appSlug: string
  features: string[]
  /** Contrato de API (fullstack): ambos generadores lo respetan para que
   *  frontend (fetch) y backend (server.js) coincidan exactamente. */
  endpoints: Array<{ method: string; path: string; purpose: string }>
  dataModel: string
  files: Array<{ path: string; purpose: string; language: string }>
}

/** Archivo producido por el generador de código (contenido íntegro). */
export interface BuildGeneratedFile {
  path: string
  content: string
}

/** Lenguaje detectado a partir de la extensión (para tarjetas y resaltado). */
export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'html':
      return 'html'
    case 'css':
      return 'css'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'js'
    case 'ts':
    case 'tsx':
      return 'ts'
    case 'json':
      return 'json'
    case 'md':
      return 'md'
    case 'svg':
      return 'svg'
    default:
      return 'text'
  }
}

/** Directiva ```oe-build emitida por el asistente del chat. */
export interface BuildDirective {
  name?: string
  brief: string
  mode?: BuildMode
  /** Proyecto existente a modificar (continuidad dentro de la conversación). */
  projectId?: string
}
