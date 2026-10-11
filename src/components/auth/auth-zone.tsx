'use client'

/**
 * AuthZone — zona de autenticación de la barra superior:
 * - Sin sesión: botones "Iniciar sesión" (Google + GitHub).
 * - Con sesión: avatar + nombre + menú (email, cerrar sesión).
 */
import { LoginButtons } from './login-buttons'
import { UserMenu } from './user-menu'
import { useAuth } from './auth-provider'

export function AuthZone() {
  const { user, loading } = useAuth()

  if (loading && !user) {
    // Espacio reservado para evitar saltos de layout (los propios botones tienen skeleton)
    return <LoginButtons />
  }

  return user ? <UserMenu /> : <LoginButtons />
}
