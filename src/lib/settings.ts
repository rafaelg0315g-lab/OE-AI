/**
 * Ajustes de OE AI persistidos en el navegador (localStorage 'oe-settings').
 * Lectura/escritura defensivas: nunca lanzan y siempre devuelven un objeto
 * completo (merge con los valores por defecto) para que la UI no tenga que
 * comprobar claves faltantes ni envolver las llamadas en try/catch.
 */

export interface OeSettings {
  /** Voz ElevenLabs seleccionada (id premade verificado por el backend). */
  voiceId: string
  /** Nombre legible de la voz (para mostrar en la UI sin catálogo). */
  voiceName: string
  /** Velocidad del habla: 0.7–1.2 (se recorta al guardar). */
  speed: number
  /** Modo intérprete: '' desactivado, o código de idioma destino. */
  translatorTarget: string
  /** Instrucciones personales (≤2000 caracteres, validado por /api/chat). */
  customInstructions: string
}

export const OE_SETTINGS_KEY = 'oe-settings'

export const DEFAULT_OE_SETTINGS: OeSettings = {
  voiceId: 'EXAVITQu4vr4xnSDxMaL',
  voiceName: 'Sarah',
  speed: 1,
  translatorTarget: '',
  customInstructions: '',
}

function clampSpeed(speed: unknown): number {
  const n = typeof speed === 'number' && Number.isFinite(speed) ? speed : DEFAULT_OE_SETTINGS.speed
  return Math.min(1.2, Math.max(0.7, Math.round(n * 100) / 100))
}

/** Lee los ajustes guardados (merge seguro con los valores por defecto). */
export function readOeSettings(): OeSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_OE_SETTINGS }
  try {
    const raw = window.localStorage.getItem(OE_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_OE_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<OeSettings> | null
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_OE_SETTINGS }
    return {
      voiceId:
        typeof parsed.voiceId === 'string' && parsed.voiceId ? parsed.voiceId : DEFAULT_OE_SETTINGS.voiceId,
      voiceName:
        typeof parsed.voiceName === 'string' && parsed.voiceName
          ? parsed.voiceName
          : DEFAULT_OE_SETTINGS.voiceName,
      speed: clampSpeed(parsed.speed),
      translatorTarget:
        typeof parsed.translatorTarget === 'string' ? parsed.translatorTarget : DEFAULT_OE_SETTINGS.translatorTarget,
      customInstructions:
        typeof parsed.customInstructions === 'string'
          ? parsed.customInstructions.slice(0, 2000)
          : DEFAULT_OE_SETTINGS.customInstructions,
    }
  } catch {
    return { ...DEFAULT_OE_SETTINGS }
  }
}

/** Guarda ajustes parciales (merge sobre lo existente) y devuelve el resultado. */
export function saveOeSettings(partial: Partial<OeSettings>): OeSettings {
  const merged: OeSettings = { ...readOeSettings(), ...partial, speed: clampSpeed(partial.speed ?? readOeSettings().speed) }
  if (typeof merged.customInstructions === 'string') {
    merged.customInstructions = merged.customInstructions.slice(0, 2000)
  }
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(OE_SETTINGS_KEY, JSON.stringify(merged))
  } catch {
    // almacenamiento lleno o bloqueado: los ajustes viven solo en memoria
  }
  return merged
}
