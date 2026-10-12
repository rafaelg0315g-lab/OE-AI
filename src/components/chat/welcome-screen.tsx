'use client'

/**
 * Pantalla de bienvenida estilo GPT/Meta AI: saludo animado con aurora,
 * composer centrado y chips de sugerencia en carrusel (marquee, una fila).
 */
import { motion } from 'framer-motion'
import { Compass, Globe, ImagePlus, Network, Rocket, Shapes, Sparkles, Wand2, type LucideIcon } from 'lucide-react'
import { CATALOG } from '@/lib/ai/catalog/catalog'
import { Composer } from './composer'
import { OeLogo, ReadyBadge } from './oe-logo'

const SUGGESTIONS = [
  {
    key: 'test',
    icon: Sparkles,
    label: 'Probar OE AI LLM',
    prompt: '¡Hola! Preséntate: ¿qué es OE AI LLM y en qué me ayudas?',
  },
  {
    key: 'image',
    icon: ImagePlus,
    label: 'Genera una imagen',
    prompt: 'Crea una imagen de un zorro geométrico estilo low poly con luces de neón verdes sobre fondo oscuro',
  },
  {
    key: 'svg',
    icon: Shapes,
    label: 'Diseña un icono SVG',
    prompt: 'Genera un icono SVG de un cohete, estilo flat minimalista',
  },
  {
    key: 'search',
    icon: Globe,
    label: 'Busca en la web',
    prompt: '/buscar Últimas noticias sobre inteligencia artificial esta semana',
  },
  {
    key: 'anything',
    icon: Compass,
    label: 'Pregunta lo que quieras',
    prompt: 'Explícame de forma sencilla cómo funciona un modelo de lenguaje grande.',
  },
  {
    key: 'action',
    icon: Rocket,
    label: 'Pasa a la acción',
    prompt: 'Ayúdame a crear un plan de marketing en 5 pasos para lanzar un producto digital este mes.',
  },
  {
    key: 'code',
    icon: Wand2,
    label: 'Escribe código',
    prompt: 'Escríbeme una función en TypeScript que valide un formulario de registro con validaciones claras.',
  },
] as const

/** Chips totales del carrusel: sugerencias + explorar la red (prompt null → abre Conexiones). */
const CHIPS: ReadonlyArray<{ key: string; icon: LucideIcon; label: string; prompt: string | null }> = [
  ...SUGGESTIONS,
  { key: 'network', icon: Network, label: 'Explora la red de modelos', prompt: null },
]

/** Botón chip del carrusel. La copia duplicada es decorativa (aria-hidden, no enfocable). */
function Chip({
  chip,
  duplicate = false,
}: {
  chip: (typeof CHIPS)[number]
  duplicate?: boolean
}) {
  return (
    <button
      type="button"
      tabIndex={duplicate ? -1 : undefined}
      aria-hidden={duplicate || undefined}
      onClick={() => {
        if (duplicate) return
        if (chip.prompt) {
          window.dispatchEvent(new CustomEvent('oe-send-suggestion', { detail: chip.prompt }))
        } else {
          window.dispatchEvent(new Event('oe-open-network'))
        }
      }}
      className="flex shrink-0 items-center gap-2 rounded-full border border-border/70 bg-secondary/40 px-3.5 py-2 text-[13px] font-medium whitespace-nowrap text-foreground/85 backdrop-blur transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-foreground"
    >
      <chip.icon className="size-4 shrink-0 text-emerald-300" aria-hidden />
      {chip.label}
    </button>
  )
}

export function WelcomeScreen() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-6">
      {/* Saludo */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="mb-5 flex flex-col items-center text-center"
      >
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.05 }}
        >
          <OeLogo size="xl" />
        </motion.div>
        <h1 className="oe-aurora-text mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
          ¿En qué puedo ayudarte?
        </h1>
        <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
          <ReadyBadge label="OE AI LLM está listo" />
          <span aria-hidden>·</span>
          <span>
            Red unificada de <span className="font-semibold text-foreground/80">{CATALOG.length} modelos</span>{' '}
            trabajando como uno
          </span>
        </div>
      </motion.div>

      {/* Composer centrado */}
      <div className="w-full max-w-2xl shrink-0">
        <Composer variant="hero" />
      </div>

      {/* Chips de sugerencia: carrusel continuo (derecha → izquierda), una fila.
          Dos copias idénticas para el bucle infinito; la segunda es decorativa.
          Pausa al pasar el mouse o al enfocar con teclado. */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.25 }}
        className="oe-marquee mt-4 w-full max-w-2xl shrink-0"
        role="region"
        aria-label="Sugerencias para empezar"
      >
        <div className="oe-marquee-track">
          <div className="flex items-center gap-2.5 pr-2.5">
            {CHIPS.map((c) => (
              <Chip key={c.key} chip={c} />
            ))}
          </div>
          <div className="flex items-center gap-2.5 pr-2.5" aria-hidden="true">
            {CHIPS.map((c) => (
              <Chip key={`dup-${c.key}`} chip={c} duplicate />
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  )
}
