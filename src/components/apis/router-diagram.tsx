/**
 * Diagrama vertical accesible del flujo de una solicitud en OE AI LLM.
 * Lista ordenada semántica (<ol>) con flechas decorativas ocultas a lectores
 * de pantalla; el orden y los números ya transmiten la secuencia.
 */
import { ArrowDown } from 'lucide-react'

import { cn } from '@/lib/utils'

const STEPS = [
  'Usuario',
  'Interfaz OE AI',
  'OE AI LLM (Model Router)',
  'Red de modelos · 128 integrantes',
  'Ruta asignada en la red',
  'Respuesta normalizada',
  'Usuario',
] as const

/** Índice (base 0) del paso del enrutador, resaltado visualmente. */
const ROUTER_STEP_INDEX = 2

export function RouterDiagram() {
  return (
    <div>
      <ol
        aria-label="Flujo de una solicitud a través de OE AI LLM"
        className="mx-auto flex w-full max-w-sm flex-col items-stretch"
      >
        {STEPS.map((step, index) => (
          <li key={`${step}-${index}`} className="flex flex-col items-center">
            <div
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border px-4 py-3',
                index === ROUTER_STEP_INDEX
                  ? 'border-primary/40 bg-primary/10'
                  : 'border-border/60 bg-card',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-lg text-xs font-semibold ring-1',
                  index === ROUTER_STEP_INDEX
                    ? 'bg-primary/20 text-primary ring-primary/40'
                    : 'bg-secondary text-muted-foreground ring-border/60',
                )}
              >
                {index + 1}
              </span>
              <span className="text-sm font-medium">{step}</span>
            </div>
            {index < STEPS.length - 1 && (
              <ArrowDown className="my-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
          </li>
        ))}
      </ol>
      <p className="mx-auto mt-5 max-w-2xl text-center text-xs leading-relaxed text-muted-foreground">
        OE AI LLM procesa cada solicitud como un modelo unificado: su enrutador asigna la ruta dentro
        de la red de 128 modelos, apoyándose en el núcleo activo del proveedor conectado, y devuelve
        una respuesta normalizada con metadatos de la ruta utilizada.
      </p>
    </div>
  )
}
