/**
 * Catálogo compartido (cliente y servidor) de voces ElevenLabs "premade"
 * verificadas y de idiomas del modo intérprete.
 *
 * Las voces "library" de ElevenLabs exigen plan de pago (HTTP 402); las
 * "premade" funcionan con la cuenta gratuita (verificado en Task 16). El
 * backend de /api/tools/tts SOLO acepta un voiceId de esta lista (whitelist).
 */
export interface PremadeVoice {
  id: string
  name: string
}

export const ELEVEN_PREMADE_VOICES: PremadeVoice[] = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' },
  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' },
  { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' },
]

/** Idiomas del modo intérprete ('' = traducción desactivada). */
export interface TranslatorLang {
  code: string
  name: string
}

export const TRANSLATOR_LANGS: TranslatorLang[] = [
  { code: '', name: 'Desactivado' },
  { code: 'en', name: 'Inglés' },
  { code: 'fr', name: 'Francés' },
  { code: 'pt', name: 'Portugués' },
  { code: 'it', name: 'Italiano' },
  { code: 'de', name: 'Alemán' },
]

/** Indica si un voiceId es una voz premade admitida por el backend. */
export function isPremadeVoice(voiceId: string): boolean {
  return ELEVEN_PREMADE_VOICES.some((v) => v.id === voiceId)
}

/** Nombre legible de un idioma del intérprete a partir de su código. */
export function translatorLangName(code: string): string {
  return TRANSLATOR_LANGS.find((l) => l.code === code)?.name ?? code
}
