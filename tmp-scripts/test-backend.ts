import { buildChatJson } from '../src/lib/build/llm'
import { coderBackendSystemPrompt, coderBackendUserPrompt } from '../src/lib/build/prompts'

const plan = {
  title: 'Lista Tareas',
  summary: 'App de tareas con backend Node puro',
  appSlug: 'lista-tareas',
  features: ['agregar tareas', 'completar', 'eliminar'],
  endpoints: [
    { method: 'GET', path: '/api/tareas', purpose: 'lista: {tareas:[{id,titulo,hecha}]}' },
    { method: 'POST', path: '/api/tareas', purpose: 'crea: body {titulo}; respuesta {tarea}' },
    { method: 'PUT', path: '/api/tareas/:id', purpose: 'actualiza hecha/titulo; respuesta {tarea}' },
    { method: 'DELETE', path: '/api/tareas/:id', purpose: 'elimina; respuesta {ok:true}' },
  ],
  dataModel: 'Tarea {id:number, titulo:string, hecha:boolean}',
  files: [],
}
const started = Date.now()
try {
  const res = await buildChatJson<{ files?: unknown }>(coderBackendSystemPrompt(), coderBackendUserPrompt(JSON.stringify(plan)))
  const files = (res.data.files as Array<{ path: string; content: string }>) ?? []
  console.log('OK', res.core, `${((Date.now() - started) / 1000).toFixed(1)}s`, files.map((f) => f.path))
} catch (err) {
  console.log('FAIL', `${((Date.now() - started) / 1000).toFixed(1)}s`, err instanceof Error ? err.message : err)
}
