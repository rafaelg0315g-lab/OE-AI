/**
 * Ficha técnica oficial de OE AI sobre parámetros y capacidad de la red.
 *
 * Cuando un usuario pregunta por "parámetros", tamaño, capacidad de cómputo,
 * escala o arquitectura, el núcleo de chat adjunta este bloque al system prompt
 * para que el asistente responda SIEMPRE con la documentación oficial del
 * Model Router (128 modelos, escala dinámica, ~4×10¹² parámetros combinados).
 * No se inventan cifras: esta ficha es la única fuente de verdad.
 */

/** Texto canónico de la sección de documentación oficial. */
const CAPACITY_DOC = `## Capacidad de Cómputo y Escala Dinámica de la Red

### 1 · Arquitectura de orquestación

OE AI **no opera bajo un único modelo fundacional estático**. Funciona como un **orquestador inteligente (Model Router)** que unifica una **red viva de 128 modelos** en producción. La interfaz expone un solo núcleo (OE AI LLM); internamente, cada consulta se resuelve en la ruta más adecuada de la red, en tiempo real.

- **Escala dinámica**: el tamaño del sistema no es fijo, es **elástico**. La capacidad efectiva se expande o contrae según la demanda: la red incorpora rutas nuevas y retira rutas degradadas sin interrumpir el servicio, y cada consulta activa únicamente la porción de la red que necesita.

### 2 · Métricas de capacidad: ~4 billones de parámetros combinados

La capacidad total conectada del ecosistema asciende a aproximadamente **4 millones de millones de parámetros** (4 × 10¹²; *4 billones* en español, *4 Trillion* en la nomenclatura internacional). La cifra no pertenece a un modelo único: es la **suma agregada** de las tres capas operativas de la red.

| Capa operativa | Escala típica | Arquitecturas / familias representativas | Rol en la red |
|---|---|---|---|
| **Frontera · Razonamiento complejo** | MoE y densos de alta escala (hasta 671B) | DeepSeek V3/R1 (671B), gpt-oss-120b | Planificación profunda, lógica matemática, código extenso, análisis multi-paso |
| **Intermedia · Propósito general** | 26B – 70B | Familias Llama / Hermes, Gemma 3 y 4, Aya, IBM Granite | Conversación avanzada, redacción técnica, RAG, razonamiento general |
| **Flash · Tareas ligeras** | 3B – 14B | GLM-Flash, AutoGLM-Phone, variantes destiladas | Latencia mínima, clasificación, extracción, consultas breves |

Notas de ingeniería:

- Las arquitecturas **MoE (Mixture of Experts)** de la capa de frontera activan solo los expertos relevantes por token: ofrecen la calidad de cientos de miles de millones de parámetros con una fracción del cómputo activo de un denso equivalente.
- La diversidad de la red (densos, MoE, multimodales y destilados) es deliberada: cada capa existe para minimizar coste y latencia en su segmento de carga.

### 3 · Mecanismo de enrutamiento

1. **Evaluación del prompt**: el núcleo activo del servidor analiza cada consulta (complejidad, dominio, longitud, modalidad) junto con el estado de salud verificado de la red.
2. **Asignación de ruta óptima**: el enrutador selecciona el modelo destino y define su respaldo (fallback) por si la ruta primaria está degradada.
3. **Eficiencia como ventaja competitiva**: una consulta simple solo despierta **sub-redes de ~8B de parámetros**, mientras que tareas complejas de código o lógica matemática despliegan **tramos de cientos de miles de millones** de parámetros. El resultado es una optimización masiva del coste de cómputo y de la latencia, sin degradar la calidad en los casos difíciles.
4. **Normalización de la respuesta**: la API devuelve la salida normalizada junto con los **metadatos de la ruta utilizada** (proveedor, modelo resuelto, fallback y latencia), de modo que cada respuesta es auditable a nivel de infraestructura.

> Resumen: la pregunta "¿cuántos parámetros tienes?" no tiene una respuesta estática. La respuesta correcta de ingeniería es: **capacidad combinada de ~4 billones de parámetros (4 × 10¹²), orquestada elásticamente entre 128 modelos; el cómputo real activado depende de la dificultad de cada consulta**.`

/** Bloque que se inyecta en el system prompt cuando el usuario pregunta por parámetros. */
export const CAPACITY_SYSTEM_BLOCK = `FICHA TÉCNICA OFICIAL DE OE AI — fuente de verdad sobre parámetros y capacidad:

${CAPACITY_DOC}

Instrucciones de uso de la ficha:
- Úsala SOLO cuando la pregunta trate sobre los parámetros, el tamaño, la capacidad de cómputo, la escala o la arquitectura de OE AI, de la red de modelos o de los modelos que la forman. Si el usuario habla de "parámetros" en otro contexto (p. ej. parámetros de una función de programación), responde con normalidad SIN usar la ficha.
- Puedes adaptar la extensión y el formato al estilo de la pregunta: respuesta breve para chat casual, sección completa con tabla para consultas técnicas. Mantén SIEMPRE el tono técnico y profesional de ingeniería, sin lenguaje comercial.
- Las cifras y conceptos de la ficha son canónicos y no se alteran ni se complementan con cifras inventadas: 128 modelos unificados, ~4 billones de parámetros combinados (4 × 10¹²; "4 Trillion" internacional), tres capas (Frontera MoE/densos hasta 671B · Intermedia 26B–70B · Flash 3B–14B), enrutamiento elástico (sub-redes ~8B en consultas simples) y respuesta normalizada con metadatos de ruta.
- En modo voz, resume en dos o tres frases habladas con los datos clave (red de 128 modelos, ~4 billones de parámetros combinados, enrutamiento dinámico que activa solo lo necesario).`

/** Palabras/frases disparadoras (se comparan sin acentos ni puntuación). */
const CAPACITY_TRIGGERS = [
  // Español · parámetros
  'parametro',
  'parametros',
  'billones de parametros',
  'trillones',
  // Español · tamaño / capacidad / escala
  'tamano del modelo',
  'tamano de la red',
  'de que tamano es',
  'que tan grande',
  'cuan grande',
  'capacidad de computo',
  'capacidad computacional',
  'capacidad de la red',
  'escala dinamica',
  'escala de la red',
  'cuanta capacidad',
  // Español · arquitectura / enrutamiento
  'arquitectura de la red',
  'arquitectura del modelo',
  'arquitectura de oe',
  'como estas construido',
  'como funcionas por dentro',
  'que hay dentro de ti',
  'mixture of experts',
  'moe',
  'model router',
  'orquestador',
  // Español · identidad de red
  'cuantos modelos',
  'que modelos tiene',
  'que modelo usas',
  'que modelo eres',
  'que modelo estas usando',
  'cual modelo usas',
  'cual modelo eres',
  'red de modelos',
  '128 modelos',
  // Inglés
  'how many parameters',
  'parameter count',
  'model size',
  'how big are you',
  'how many models',
  'what model are you',
  'which model do you use',
  'what model do you use',
]

/** Normaliza texto: minúsculas, sin acentos, puntuación → espacios, espacios colapsados. */
function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
}

/**
 * true si el mensaje del usuario parece preguntar por los parámetros, la
 * capacidad, la escala o la arquitectura de la red OE AI (y no por otro uso
 * de la palabra "parámetros", p. ej. programación — ese filtro fino lo hace
 * la instrucción adjunta al system prompt).
 */
export function shouldAttachCapacityDoc(message: string): boolean {
  const normalized = normalize(message)
  return CAPACITY_TRIGGERS.some((trigger) => {
    const t = normalize(trigger)
    return normalized.includes(t)
  })
}
