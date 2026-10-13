/**
 * Eventos de progreso del constructor de apps/sitios (streaming en vivo).
 *
 * Los pipelines (`src/lib/build/pipeline.ts` y `src/lib/web-factory/pipeline.ts`)
 * emiten eventos a través de un `BuildProgressSink` opcional; la ruta SSE
 * (`/api/tools/build-stream`) los reenvía al chat en tiempo real.
 *
 * Contrato de eventos:
 *  - title       → título/resumen del proyecto (tras el plan).
 *  - todos       → lista de tareas visible (se crea con las pendientes).
 *  - todo_update → cambio de estado de una tarea (active|done|failed).
 *  - stage_note  → nota de etapa para el estado de la UI.
 *  - file_done   → archivo COMPLETO generado (con contenido): la ruta lo
 *                  persiste enseguida y habilita su descarga individual.
 */

export type BuildTodoStatus = 'pending' | 'active' | 'done' | 'failed'

export interface BuildTodo {
  id: string
  label: string
  status: BuildTodoStatus
}

export type BuildProgressEvent =
  | { type: 'title'; title: string; summary: string }
  | { type: 'todos'; items: BuildTodo[] }
  | { type: 'todo_update'; id: string; status: BuildTodoStatus }
  | { type: 'stage_note'; note: string }
  | { type: 'file_done'; path: string; language: string; bytes: number; content: string }

export type BuildProgressSink = (event: BuildProgressEvent) => void

/** Crea un sink que emite solo si hay callback (evita `if (onProgress)` por doquier). */
export function createProgressSink(onProgress?: BuildProgressSink): BuildProgressSink {
  return (event) => {
    try {
      onProgress?.(event)
    } catch {
      // El consumidor (SSE) nunca debe tumbar el pipeline.
    }
  }
}
