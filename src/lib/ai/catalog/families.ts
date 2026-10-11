/**
 * Familias de modelos derivadas del prefijo de organización del identificador.
 *
 * NOTA DE PROCEDENCIA: el nombre de familia se deriva del prefijo del ID
 * (p. ej. 'zai-org/...' → 'Z.ai'). Es una clasificación interna del catálogo,
 * no una afirmación oficial de cada organización.
 */
export interface FamilyInfo {
  id: string
  label: string
}

const FAMILY_MAP: Record<string, string> = {
  Qwen: 'Qwen (Alibaba)',
  'deepseek-ai': 'DeepSeek',
  'zai-org': 'Z.ai (Zhipu AI)',
  'meta-llama': 'Meta Llama',
  'meta-models': 'Meta (meta-models)',
  moonshotai: 'Moonshot AI (Kimi)',
  XiaomiMiMo: 'Xiaomi MiMo',
  google: 'Google (Gemma)',
  openai: 'OpenAI (gpt-oss)',
  'prism-ml': 'Prism ML',
  thinkingmachines: 'Thinking Machines',
  inclusionAI: 'InclusionAI (Ling)',
  MiniMaxAI: 'MiniMax',
  tencent: 'Tencent',
  CohereLabs: 'Cohere Labs',
  speakleash: 'SpeakLeash (Bielik)',
  nvidia: 'NVIDIA (Nemotron)',
  'ibm-granite': 'IBM Granite',
  microsoft: 'Microsoft (Phi)',
  'stepfun-ai': 'StepFun',
  Sao10K: 'Sao10K (comunidad)',
  NousResearch: 'Nous Research',
  alpindale: 'Alpindale (comunidad)',
  mistralai: 'Mistral AI',
  'swiss-ai': 'Swiss AI (Apertus)',
  aisingapore: 'AI Singapore (SEA-LION)',
}

export function resolveFamily(modelId: string): FamilyInfo {
  const prefix = modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : modelId
  const label = FAMILY_MAP[prefix] ?? `${prefix} (prefijo de organización)`
  return { id: prefix, label }
}
