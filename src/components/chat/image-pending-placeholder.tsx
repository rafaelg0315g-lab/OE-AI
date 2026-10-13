'use client'

/**
 * Placeholder "aurora nube" (nivel pro) mientras se genera una imagen:
 * auroras difusas estilo nube (esmeralda/teal/violeta/cielo) que flotan
 * orgánicamente, capa de nubes blancas que cruzan en deriva lenta, rejilla de
 * puntos que se enciende al paso de las auroras, viñeta suave, notas de etapa
 * sincronizadas con el servidor (SSE stage) y barra de progreso barrida.
 * Formato cuadrado, acorde a la imagen PNG estándar que produce el núcleo.
 */
import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Sparkles } from 'lucide-react'

const DOTS = 'radial-gradient(rgba(255,255,255,0.5) 1px, transparent 1.45px)'

function stageLabel(seconds: number): string {
  if (seconds < 12) return 'Componiendo la escena'
  if (seconds < 35) return 'Pintando los detalles'
  if (seconds < 70) return 'Dando los toques finales'
  return 'Afinando los últimos píxeles'
}

export interface ImagePendingPlaceholderProps {
  /** Nota de etapa enviada por el servidor (SSE stage note). Si existe, manda. */
  note?: string | null
  /** Segundos reportados por el servidor (solo informativo). */
  elapsed?: number | null
}

export function ImagePendingPlaceholder({ note, elapsed }: ImagePendingPlaceholderProps) {
  const reduceMotion = useReducedMotion()
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const stage = note?.trim() ? note.trim() : stageLabel(seconds)
  const shownSeconds = typeof elapsed === 'number' && elapsed > seconds ? elapsed : seconds

  const float = (values: Record<string, string[]>, duration: number, delay = 0) =>
    reduceMotion
      ? {}
      : { animate: values, transition: { duration, repeat: Infinity, ease: 'easeInOut' as const, delay } }

  return (
    <div
      role="status"
      aria-label={`Generando imagen: ${stage}. ${shownSeconds} segundos transcurridos.`}
      className="relative aspect-square w-full max-w-[340px] overflow-hidden rounded-3xl border border-white/10 bg-[#050810] shadow-xl"
    >
      {/* Auroras estilo nube: blobs grandes, difusos y orgánicos */}
      <motion.div
        aria-hidden
        className="absolute -left-1/5 -top-1/4 size-[90%] rounded-full bg-emerald-500/45 blur-[70px]"
        {...float({ x: ['0%', '34%', '10%', '0%'], y: ['0%', '24%', '46%', '0%'], scale: ['1', '1.2', '0.94', '1'] }, 12)}
      />
      <motion.div
        aria-hidden
        className="absolute -bottom-1/5 -right-1/4 size-[85%] rounded-full bg-teal-400/40 blur-[80px]"
        {...float({ x: ['0%', '-28%', '-6%', '0%'], y: ['0%', '-22%', '12%', '0%'], scale: ['1', '1.24', '0.96', '1'] }, 15, 0.8)}
      />
      <motion.div
        aria-hidden
        className="absolute left-1/5 top-1/3 size-[70%] rounded-full bg-violet-500/35 blur-[70px]"
        {...float({ x: ['0%', '22%', '-18%', '0%'], y: ['0%', '-16%', '20%', '0%'] }, 19, 0.4)}
      />
      <motion.div
        aria-hidden
        className="absolute right-0 top-0 size-[60%] rounded-full bg-sky-400/25 blur-[75px]"
        {...float({ x: ['0%', '-20%', '12%', '0%'], y: ['0%', '30%', '-10%', '0%'] }, 23, 1.6)}
      />

      {/* Nubes blancas en deriva lenta (capa tipo nube sobre la aurora) */}
      {(
        [
          { className: 'left-[-30%] top-[18%] h-[26%] w-[85%] bg-white/[0.09]', duration: 26, delay: 0 },
          { className: 'right-[-35%] top-[52%] h-[22%] w-[80%] bg-white/[0.07]', duration: 34, delay: 3 },
          { className: 'left-[-20%] top-[78%] h-[18%] w-[70%] bg-white/[0.05]', duration: 42, delay: 6 },
        ] as const
      ).map((cloud, i) => (
        <motion.div
          key={i}
          aria-hidden
          className={`absolute rounded-[100%] blur-2xl ${cloud.className}`}
          {...float({ x: ['-14%', '14%', '-14%'] }, cloud.duration, cloud.delay)}
        />
      ))}

      {/* Rejilla de puntos que se enciende al paso de las auroras */}
      <div aria-hidden className="absolute inset-0 mix-blend-overlay" style={{ backgroundImage: DOTS, backgroundSize: '13px 13px' }} />
      <div
        aria-hidden
        className="oe-aurora-dots absolute inset-0 opacity-40 mix-blend-screen"
        style={{ backgroundImage: DOTS, backgroundSize: '13px 13px', animation: reduceMotion ? undefined : 'oe-aurora-drift 22s linear infinite' }}
      />

      {/* Viñeta suave hacia los bordes */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: 'radial-gradient(120% 90% at 50% 42%, transparent 40%, rgba(0,0,0,0.6) 100%)' }}
      />

      {/* Contenido central */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-5 text-center">
        <div className="relative">
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-2xl border border-emerald-300/40"
            {...float({ scale: [1, 1.35], opacity: [0.7, 0] }, 1.8)}
          />
          <motion.span
            className="grid size-13 place-items-center rounded-2xl border border-white/15 bg-white/10 backdrop-blur-sm"
            {...float({ scale: ['1', '1.06', '1'] }, 2.6)}
          >
            <Sparkles className="size-6 text-emerald-200" aria-hidden />
          </motion.span>
        </div>
        <span className="oe-shimmer text-sm font-semibold">Generando imagen</span>
        <span className="text-xs text-white/65">{stage}…</span>
        <span className="font-mono text-[11px] tabular-nums text-white/45">{shownSeconds} s · imagen IA</span>
      </div>

      {/* Barra de progreso barrida */}
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-3xl bg-white/10">
        {!reduceMotion && (
          <motion.div
            className="h-full w-1/3 rounded-full bg-gradient-to-r from-emerald-400 via-teal-300 to-violet-400"
            animate={{ x: ['-120%', '340%'] }}
            transition={{ duration: 2.1, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </div>
    </div>
  )
}
