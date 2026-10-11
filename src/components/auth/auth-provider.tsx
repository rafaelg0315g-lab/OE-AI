'use client'

/**
 * AuthProvider — sesión de Supabase (OAuth: Google + GitHub) para toda la app.
 *
 * - Escucha onAuthStateChange y expone el perfil normalizado (useAuth).
 * - Al iniciar sesión sincroniza la identidad en el backend (/api/auth/sync),
 *   donde el access token se valida contra Supabase antes de guardarse.
 * - Estados honestos: loading, signingInProvider y errores visibles; nunca
 *   sesión simulada.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { Toaster as SonnerToaster } from '@/components/ui/sonner'
import { getSupabase, supabaseConfigured, type OeAuthUser } from '@/lib/supabase'

export type OAuthProvider = 'google' | 'github'

type AuthState = {
  user: OeAuthUser | null
  /** true mientras se restaura la sesión inicial. */
  loading: boolean
  /** Proveedor en tránsito ('google' | 'github'); null en reposo. */
  signingInProvider: OAuthProvider | null
  /** true cuando hay credenciales de Supabase en el entorno. */
  configured: boolean
  signInWith: (provider: OAuthProvider) => Promise<void>
  signOut: () => Promise<void>
  /** Access token vigente de Supabase (para APIs que validan en servidor). */
  getAccessToken: () => Promise<string | null>
}

const AuthContext = createContext<AuthState | null>(null)

function profileFromSession(session: {
  user?: {
    id?: string
    email?: string | null
    user_metadata?: Record<string, unknown>
  } | null
} | null): OeAuthUser | null {
  const u = session?.user
  if (!u?.id) return null
  const meta = u.user_metadata ?? {}
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = meta[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return null
  }
  // user_name = login de GitHub (Supabase lo entrega en user_metadata).
  const name = pick('full_name', 'name', 'display_name', 'user_name') ?? u.email?.split('@')[0] ?? 'Usuario'
  const avatarUrl = pick('avatar_url', 'picture')
  // GitHub puede autenticar usuarios sin email público (toggle "Allow users
  // without an email"): Supabase entrega un email sintético noreply, pero si
  // faltara usamos un fallback determinista para no romper la sesión.
  const email = u.email?.trim() || `${pick('user_name') ?? u.id}@users.noreply.github.com`
  return { id: u.id, email, name, avatarUrl }
}

/** Sincroniza la identidad en el backend (el servidor valida el token). */
async function syncBackend(accessToken: string): Promise<void> {
  try {
    const res = await fetch('/api/auth/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      console.warn('[auth] sincronización no completada:', res.status, body.error ?? '')
    }
  } catch (err) {
    console.warn('[auth] sincronización no disponible:', err)
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<OeAuthUser | null>(null)
  // Si Supabase no está configurado no hay nada que restaurar: sin estado de carga.
  const [loading, setLoading] = useState(() => supabaseConfigured)
  const [signingInProvider, setSigningInProvider] = useState<OAuthProvider | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    if (!supabaseConfigured) {
      return () => {
        mounted.current = false
      }
    }

    const supabase = getSupabase()

    // Restaurar sesión existente (o la recién completada al volver del proveedor OAuth)
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted.current) return
        setUser(profileFromSession(data.session))
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted.current) return
      const profile = profileFromSession(
        session as Parameters<typeof profileFromSession>[0] | null,
      )
      setUser(profile)
      if (event === 'SIGNED_IN' && profile && session?.access_token) {
        void syncBackend(session.access_token)
        // Espejo opcional en la tabla public.profiles de Supabase
        // (requiere ejecutar supabase/schema.sql en el proyecto; fallo silencioso y honesto).
        void getSupabase()
          .from('profiles')
          .upsert(
            {
              id: profile.id,
              email: profile.email,
              full_name: profile.name,
              avatar_url: profile.avatarUrl,
              last_login_at: new Date().toISOString(),
            },
            { onConflict: 'id' },
          )
          .then(({ error }) => {
            if (error) {
              console.info(
                '[auth] public.profiles aún no disponible (ejecuta supabase/schema.sql):',
                error.message,
              )
            }
          })
      }
      if (event === 'SIGNED_OUT') setUser(null)
    })

    // Keep-alive de sesión: renueva el token aunque la pestaña lleve abierta
    // horas o días (getSession refresca si está expirada). Así el login se
    // mantiene activo "para siempre" mientras el usuario no cierre sesión.
    const KEEP_ALIVE_MS = 5 * 60_000
    const keepAlive = setInterval(() => {
      if (!mounted.current) return
      void supabase.auth.getSession().catch((err) => {
        console.warn('[auth] keep-alive no pudo refrescar la sesión:', err)
      })
    }, KEEP_ALIVE_MS)

    return () => {
      mounted.current = false
      clearInterval(keepAlive)
      data.subscription.unsubscribe()
    }
  }, [])

  const signInWith = useCallback(async (provider: OAuthProvider) => {
    if (!supabaseConfigured) {
      toast.error('Supabase no está configurado en este entorno')
      return
    }
    setSigningInProvider(provider)
    try {
      const { error } = await getSupabase().auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/` },
      })
      if (error) {
        toast.error(`No se pudo iniciar sesión: ${error.message}`)
        setSigningInProvider(null)
      }
      // Si todo va bien, el navegador redirige al proveedor (no hay que limpiar el estado).
    } catch (err) {
      toast.error('Error de red al contactar con Supabase')
      console.warn('[auth] signInWithOAuth:', err)
      setSigningInProvider(null)
    }
  }, [])

  const signOut = useCallback(async () => {
    try {
      await getSupabase().auth.signOut()
      setUser(null)
      toast.success('Sesión cerrada')
    } catch (err) {
      console.warn('[auth] signOut:', err)
      toast.error('No se pudo cerrar la sesión')
    }
  }, [])

  /** Token vigente para llamadas autenticadas (el servidor lo revalida siempre). */
  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (!supabaseConfigured) return null
    try {
      const { data } = await getSupabase().auth.getSession()
      return data.session?.access_token ?? null
    } catch {
      return null
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      signingInProvider,
      configured: supabaseConfigured,
      signInWith,
      signOut,
      getAccessToken,
    }),
    [user, loading, signingInProvider, signInWith, signOut, getAccessToken],
  )

  return (
    <AuthContext.Provider value={value}>
      {children}
      <SonnerToaster theme="dark" position="top-center" richColors closeButton />
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>')
  return ctx
}
