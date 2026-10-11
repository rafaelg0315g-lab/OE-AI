/**
 * Pipeline del Constructor de Apps de OE AI — archivos reales, nada simulado.
 *
 * Orquesta el turno completo contra núcleos LLM reales:
 *   1. Plan CONTRATO (planificador → JSON): título, características y la
 *      especificación exacta de los endpoints /api/* del proyecto.
 *   2. Código en DOS mitades PARALELAS (frontend y backend) que comparten el
 *      contrato: fetch del frontend = endpoints implementados en server.js.
 *   3. Saneamiento de rutas + reintento dirigido si falta algún esencial.
 *   4. Variante "update": modifica un proyecto existente con el contexto de
 *      sus archivos actuales (solo devuelve los archivos creados/modificados).
 *
 * Sin disco, sin servidores y sin vista previa: los archivos completos se
 * persisten en DB (BuildProject/BuildFile) y se descargan desde el chat.
 * Cada etapa registra su duración y núcleo en el log del servidor (sin contenido).
 */
import { BuildLlmError, buildChatJson } from './llm'
import {
  coderBackendSystemPrompt,
  coderBackendUserPrompt,
  coderFrontendOnlySystemPrompt,
  coderFrontendSystemPrompt,
  coderFrontendUserPrompt,
  plannerSystemPrompt,
  plannerUserPrompt,
  updaterSystemPrompt,
  updaterUserPrompt,
} from './prompts'
import {
  isBuildMode,
  languageFromPath,
  type BuildGeneratedFile,
  type BuildMode,
  type BuildPlan,
} from './types'

export class BuildPipelineError extends Error {
  errorType: 'rate_limited' | 'empty_response' | 'json_parse' | 'provider_error' | 'invalid_plan' | 'no_files' | 'aborted'

  constructor(message: string, errorType: BuildPipelineError['errorType']) {
    super(message)
    this.errorType = errorType
  }
}

const MAX_FILES = 8
const MAX_FILE_BYTES = 120_000

/** Sanea y valida la ruta de un archivo generado (relativa, segura, útil). */
function sanitizePath(rawPath: string): string | null {
  const path = String(rawPath ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
  if (!path) return null
  if (path.includes('..') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null
  if (path.length > 120) return null
  if (!/^[\w./-]+$/.test(path)) return null
  return path
}

function clampContent(content: string): string {
  return content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) : content
}

/** Normaliza la lista de archivos del generador (rutas válidas, contenido no vacío). */
function normalizeGeneratedFiles(raw: unknown): BuildGeneratedFile[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const files: BuildGeneratedFile[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as { path?: unknown; content?: unknown }
    const path = sanitizePath(typeof record.path === 'string' ? record.path : '')
    const content = typeof record.content === 'string' ? record.content : ''
    if (!path || !content.trim()) continue
    if (seen.has(path)) continue
    seen.add(path)
    files.push({ path, content: clampContent(content) })
  }
  return files
}

export interface BuildResult {
  title: string
  summary: string
  appSlug: string
  features: string[]
  plan: BuildPlan
  files: BuildGeneratedFile[]
  core: string
  isUpdate: boolean
  changedPaths: string[]
}

interface RawPlan {
  title?: unknown
  summary?: unknown
  appSlug?: unknown
  features?: unknown
  endpoints?: unknown
  dataModel?: unknown
  files?: unknown
}

function parsePlan(data: RawPlan): BuildPlan {
  const rawFiles = Array.isArray(data.files) ? data.files : []
  const planFiles = rawFiles
    .map((f) => {
      const rec = (f ?? {}) as { path?: unknown; purpose?: unknown; language?: unknown }
      const path = sanitizePath(typeof rec.path === 'string' ? rec.path : '')
      if (!path) return null
      return {
        path,
        purpose: String(rec.purpose ?? '').slice(0, 300),
        language: languageFromPath(path),
      }
    })
    .filter((f): f is BuildPlan['files'][number] => f !== null)
    .slice(0, MAX_FILES)

  if (planFiles.length === 0) {
    throw new BuildPipelineError('El plan no produjo archivos utilizables.', 'invalid_plan')
  }

  const endpoints = Array.isArray(data.endpoints)
    ? data.endpoints
        .map((e) => {
          const rec = (e ?? {}) as { method?: unknown; path?: unknown; purpose?: unknown }
          return {
            method: String(rec.method ?? 'GET').slice(0, 8).toUpperCase(),
            path: String(rec.path ?? '').slice(0, 120),
            purpose: String(rec.purpose ?? '').slice(0, 300),
          }
        })
        .filter((e) => e.path.startsWith('/api/'))
        .slice(0, 8)
    : []

  return {
    title: String(data.title ?? 'Nueva app').slice(0, 60),
    summary: String(data.summary ?? '').slice(0, 400),
    appSlug:
      String(data.appSlug ?? 'oe-app')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'oe-app',
    features: Array.isArray(data.features)
      ? data.features.map((f) => String(f).slice(0, 160)).slice(0, 6)
      : [],
    endpoints,
    dataModel: String(data.dataModel ?? '').slice(0, 500),
    files: planFiles,
  }
}

const ESSENTIALS_FULLSTACK = ['index.html', 'styles.css', 'app.js', 'server.js', 'package.json', 'README.md']
const ESSENTIALS_FRONTEND = ['index.html', 'styles.css', 'app.js', 'README.md']

/** Reintento dirigido: genera SOLO los archivos esenciales que faltan. */
async function fillMissing(
  missing: Array<{ path: string; purpose: string }>,
  plan: BuildPlan,
  mode: BuildMode,
  signal?: AbortSignal,
): Promise<BuildGeneratedFile[]> {
  if (missing.length === 0) return []
  const planJson = JSON.stringify(plan)
  try {
    const isFrontendMissing = missing.every((m) => ['index.html', 'styles.css', 'app.js', 'README.md'].includes(m.path))
    const { data } = await buildChatJson<Record<string, unknown>>(
      mode === 'fullstack' && !isFrontendMissing ? coderBackendSystemPrompt() : coderFrontendOnlySystemPrompt(),
      [
        'Tu respuesta anterior omitió archivos esenciales del plan. Genera ÚNICAMENTE estos archivos, completos:',
        missing.map((m) => `- ${m.path} (${m.purpose || 'archivo del plan'})`).join('\n'),
        `Plan y contrato de API:\n${planJson.slice(0, 7000)}`,
        'Responde con el JSON {"files": [...]} incluyendo solo esos archivos.',
      ].join('\n\n'),
      signal,
    )
    return normalizeGeneratedFiles(data.files)
  } catch {
    return [] // best-effort
  }
}

/** Ejecuta el constructor completo para una petición nueva. */
export async function runBuild(input: {
  brief: string
  mode: BuildMode
  signal?: AbortSignal
}): Promise<BuildResult> {
  // 1) Plan CONTRATO
  const planStart = Date.now()
  const planRes = await buildChatJson<RawPlan>(plannerSystemPrompt(), plannerUserPrompt(input.brief, input.mode), input.signal)
  const plan = parsePlan(planRes.data)
  console.error(`[build] plan ${((Date.now() - planStart) / 1000).toFixed(1)}s vía ${planRes.core} · ${plan.files.length} archivos · ${plan.endpoints.length} endpoints`)

  // 2) Código en dos mitades paralelas que comparten el contrato
  const codeStart = Date.now()
  const planJson = JSON.stringify(plan)
  let files: BuildGeneratedFile[]
  let core = planRes.core

  if (input.mode === 'fullstack') {
    const [front, back] = await Promise.allSettled([
      buildChatJson<{ files?: unknown }>(coderFrontendSystemPrompt(), coderFrontendUserPrompt(planJson), input.signal),
      buildChatJson<{ files?: unknown }>(coderBackendSystemPrompt(), coderBackendUserPrompt(planJson), input.signal),
    ])
    if (front.status === 'rejected' && back.status === 'rejected') {
      // Ambas mitades fallaron: propagar el primer error real.
      throw front.reason instanceof Error ? front.reason : new BuildPipelineError('El generador falló.', 'provider_error')
    }
    files = []
    if (front.status === 'fulfilled') {
      core = front.value.core
      files.push(...normalizeGeneratedFiles(front.value.data.files))
    }
    if (back.status === 'fulfilled') {
      files.push(...normalizeGeneratedFiles(back.value.data.files))
    }
    console.error(`[build] código paralelo ${((Date.now() - codeStart) / 1000).toFixed(1)}s · frontend:${front.status} backend:${back.status} · ${files.length} archivos`)
  } else {
    const single = await buildChatJson<{ files?: unknown }>(
      coderFrontendOnlySystemPrompt(),
      `Implementa la app completa sin backend según el plan.\n\nPlan:\n${planJson.slice(0, 7000)}`,
      input.signal,
    )
    core = single.core
    files = normalizeGeneratedFiles(single.data.files)
    console.error(`[build] código ${((Date.now() - codeStart) / 1000).toFixed(1)}s vía ${core} · ${files.length} archivos`)
  }

  // 3) Completar esenciales que falten (reintento dirigido)
  const essentials = input.mode === 'fullstack' ? ESSENTIALS_FULLSTACK : ESSENTIALS_FRONTEND
  const missing = essentials
    .filter((p) => !files.some((f) => f.path === p))
    .map((p) => ({ path: p, purpose: plan.files.find((f) => f.path === p)?.purpose ?? 'archivo esencial del plan' }))
  if (missing.length > 0 && missing.length < essentials.length) {
    const filled = await fillMissing(missing, plan, input.mode, input.signal)
    for (const f of filled) {
      if (!files.some((x) => x.path === f.path)) files.push(f)
    }
  }

  if (files.length === 0) {
    throw new BuildPipelineError('El generador no produjo archivos utilizables.', 'no_files')
  }

  return {
    title: plan.title,
    summary: plan.summary,
    appSlug: plan.appSlug,
    features: plan.features,
    plan,
    files,
    core,
    isUpdate: false,
    changedPaths: files.map((f) => f.path),
  }
}

/** Ejecuta el constructor en modo modificación sobre un proyecto existente. */
export async function runBuildUpdate(input: {
  changeRequest: string
  currentFiles: Array<{ path: string; content: string }>
  signal?: AbortSignal
}): Promise<BuildResult> {
  const start = Date.now()
  const res = await buildChatJson<{ summary?: unknown; files?: unknown }>(
    updaterSystemPrompt(),
    updaterUserPrompt({
      changeRequest: input.changeRequest,
      filePaths: input.currentFiles.map((f) => f.path),
      currentFiles: input.currentFiles,
    }),
    input.signal,
  )
  console.error(`[build:update] ${((Date.now() - start) / 1000).toFixed(1)}s vía ${res.core}`)

  const files = normalizeGeneratedFiles(res.data.files)
  if (files.length === 0) {
    throw new BuildPipelineError('El generador no produjo cambios utilizables.', 'no_files')
  }

  return {
    title: '',
    summary: String(res.data.summary ?? '').slice(0, 400),
    appSlug: '',
    features: [],
    plan: { title: '', summary: '', appSlug: '', features: [], endpoints: [], dataModel: '', files: [] },
    files,
    core: res.core,
    isUpdate: true,
    changedPaths: files.map((f) => f.path),
  }
}

/** Convierte errores internos en mensajes honestos para el usuario. */
export function buildErrorMessage(err: unknown): { message: string; errorType: string } {
  if (err instanceof BuildPipelineError) return { message: err.message, errorType: err.errorType }
  if (err instanceof BuildLlmError) {
    if (err.errorType === 'aborted') return { message: 'Construcción cancelada.', errorType: 'aborted' }
    return { message: err.message, errorType: err.errorType }
  }
  return {
    message: 'El constructor no pudo completar la app con ningún núcleo configurado. No se generó nada simulado.',
    errorType: 'provider_error',
  }
}

/** Guardia de modo: normaliza el modo recibido de la directiva del modelo. */
export function normalizeMode(raw: unknown): BuildMode {
  return isBuildMode(raw) ? raw : 'fullstack'
}
