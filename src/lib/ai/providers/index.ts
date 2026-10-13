/**
 * ProviderRegistry — registro central de adaptadores de proveedores.
 *
 * Proveedores del material fuente de OE BUSINESS. La disponibilidad real de
 * cada uno se determina con credenciales + comprobaciones; por defecto figuran
 * como "Disponible con configuración" (o "En planificación" cuando ni siquiera
 * está definido el endpoint).
 */
import { ENABLED_MODEL_ROUTES } from '../config'
import type { AIProviderAdapter } from '../types'
import { createZaiAdapter } from './zai'
import { createOpenAICompatibleAdapter, type OpenAICompatibleProviderDef } from './openai-compatible'

const OPENAI_COMPATIBLE_DEFS: OpenAICompatibleProviderDef[] = [
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envVarNames: ['NVIDIA_API_KEY'],
    endpointStatus: 'verified',
    streaming: true, // SSE verificado con prueba real (deltas tipo OpenAI)
    note: 'Endpoint verificado con prueba real: chat/completions y streaming SSE sobre IAs de código abierto (nemotron-3-super-120b, deepseek, glm…). El adaptador envía chat_template_kwargs {thinking:false} para que el contenido no se queme en razonamiento interno.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVarNames: ['OPENROUTER_API_KEY'],
    endpointStatus: 'verified',
    streaming: true, // SSE verificado con pruebas reales (deltas + [DONE])
    extraHeaders: {
      // Cabeceras recomendadas por OpenRouter para atribución (sin secretos).
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'OE AI',
    },
    note: 'Endpoint verificado con pruebas reales: catálogo vivo (GET /models), chat/completions con selección de modelo y streaming SSE. Acepta los identificadores del catálogo OE AI tal cual (normaliza mayúsculas/minúsculas).',
  },
  {
    id: 'novita',
    label: 'Novita AI',
    baseUrl: 'https://api.novita.ai/v3/openai',
    envVarNames: ['NOVITA_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo. Endpoint y formato por confirmar contra la documentación vigente de Novita antes de dar por válida la integración.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    envVarNames: ['CEREBRAS_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo. Endpoint por confirmar con la documentación vigente de Cerebras.',
  },
  {
    id: 'ovhcloud',
    label: 'OVHcloud AI Endpoints',
    baseUrl: 'https://oai.endpoints.ke.ai.ovh.net/v1',
    envVarNames: ['OVHCLOUD_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo. Endpoint por confirmar; OVHcloud expone endpoints de inferencia con formato propio/compatible.',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    envVarNames: ['DEEPINFRA_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo. Endpoint por confirmar con la documentación vigente de DeepInfra.',
  },
  {
    id: 'fireworks-ai',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    envVarNames: ['FIREWORKS_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo. Endpoint por confirmar con la documentación vigente de Fireworks.',
  },
  {
    id: 'baseten',
    label: 'Baseten',
    baseUrl: null,
    envVarNames: ['BASETEN_API_KEY'],
    endpointStatus: 'planned',
    note: 'Endpoint no definido aún. Requiere confirmar el formato de API de los despliegues de Baseten antes de habilitar rutas.',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    envVarNames: ['TOGETHER_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo. Endpoint por confirmar con la documentación vigente de Together.',
  },
  {
    id: 'nscale',
    label: 'Nscale',
    baseUrl: null,
    envVarNames: ['NSCALE_API_KEY'],
    endpointStatus: 'planned',
    note: 'Endpoint no definido aún. Requiere documentación del proveedor.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envVarNames: ['GROQ_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo. Endpoint por confirmar con la documentación vigente de Groq.',
  },
  {
    id: 'scaleway',
    label: 'Scaleway Generative APIs',
    baseUrl: 'https://api.scaleway.ai/v1',
    envVarNames: ['SCALEWAY_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo. Endpoint por confirmar con la documentación vigente de Scaleway.',
  },
  {
    id: 'publicai',
    label: 'PublicAI',
    baseUrl: null,
    envVarNames: ['PUBLICAI_API_KEY'],
    endpointStatus: 'planned',
    note: 'Endpoint no definido aún. Requiere documentación del proveedor.',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    envVarNames: ['COHERE_API_KEY'],
    endpointStatus: 'needs_verification',
    note: 'Adaptador listo usando el endpoint de compatibilidad de Cohere; por confirmar vigencia y cobertura de modelos.',
  },
]

function buildAdapters(): AIProviderAdapter[] {
  const adapters: AIProviderAdapter[] = [createZaiAdapter()]
  for (const def of OPENAI_COMPATIBLE_DEFS) {
    adapters.push(createOpenAICompatibleAdapter(def, ENABLED_MODEL_ROUTES))
  }
  return adapters
}

const ADAPTERS = buildAdapters()

export const providerRegistry = {
  list(): AIProviderAdapter[] {
    return ADAPTERS
  },
  get(id: string): AIProviderAdapter | undefined {
    return ADAPTERS.find((a) => a.id === id)
  },
  /** Rutas realmente servibles ahora mismo (configuradas). */
  availableRoutes() {
    return ADAPTERS.flatMap((a) => a.routableRoutes())
  },
}

export type { AIProviderAdapter }
