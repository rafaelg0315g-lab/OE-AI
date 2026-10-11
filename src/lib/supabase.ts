'use client'

/**
 * Cliente global de Supabase para OE AI.
 *
 * - Las credenciales viven en .env (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   guardadas también en el formato VITE_* solicitado por el propietario).
 * - Es una clave pública (publishable): puede vivir en el navegador; el acceso a
 *   filas lo gobierna RLS en Supabase. Ninguna clave privada llega al cliente.
 * - Exporta la instancia `supabase` (singleton perezoso) para usarla globalmente.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

/** true cuando hay credenciales configuradas en el entorno. */
export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

let cached: SupabaseClient | null = null

/**
 * Devuelve la instancia única de Supabase. Lanza un error claro si faltan
 * credenciales (estado honesto: nunca simulamos sesión).
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseConfigured) {
    throw new Error(
      'Supabase no está configurado: faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY en .env',
    )
  }
  if (!cached) {
    cached = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true, // guarda la sesión en localStorage (sobrevive al cierre del navegador)
        autoRefreshToken: true, // renueva el access token automáticamente antes de expirar
        detectSessionInUrl: true, // completa el login al volver de Google
        flowType: 'pkce', // flujo PKCE: intercambio de código más robusto ante redirecciones
      },
    })
  }
  return cached
}

// Instancia global (creación perezosa en el primer acceso; si faltan
// credenciales el fallo es explícito y no rompe el arranque del bundle).
export const supabase = {
  auth: {
    signInWithOAuth: (...args: Parameters<SupabaseClient['auth']['signInWithOAuth']>) =>
      getSupabase().auth.signInWithOAuth(...args),
    signOut: (...args: Parameters<SupabaseClient['auth']['signOut']>) =>
      getSupabase().auth.signOut(...args),
    getSession: (...args: Parameters<SupabaseClient['auth']['getSession']>) =>
      getSupabase().auth.getSession(...args),
    getUser: (...args: Parameters<SupabaseClient['auth']['getUser']>) =>
      getSupabase().auth.getUser(...args),
    onAuthStateChange: (...args: Parameters<SupabaseClient['auth']['onAuthStateChange']>) =>
      getSupabase().auth.onAuthStateChange(...args),
  },
  from: (table: string) => getSupabase().from(table),
} as const

/** Perfil normalizado de OE a partir de un usuario de Supabase Auth. */
export type OeAuthUser = {
  id: string
  email: string
  name: string
  avatarUrl: string | null
}
