'use client'

/**
 * Menú del usuario autenticado: avatar, nombre, email y cierre de sesión.
 */
import { ChevronDown, LogOut, Settings2 } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from './auth-provider'

function initialsOf(name: string, email: string): string {
  const base = name.trim() || email.split('@')[0] || 'OE'
  const parts = base.split(/[\s._-]+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '')
  return letters.join('') || 'OE'
}

export function UserMenu() {
  const { user, signOut } = useAuth()
  if (!user) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full border border-border/50 bg-accent/40 py-1 pl-1 pr-2 transition-colors hover:bg-accent/70"
          aria-label={`Cuenta de ${user.name}. Abrir menú de usuario`}
        >
          <Avatar className="size-7">
            {user.avatarUrl ? (
              <AvatarImage src={user.avatarUrl} alt={`Avatar de ${user.name}`} />
            ) : null}
            <AvatarFallback className="bg-emerald-500/15 text-[11px] font-bold text-emerald-300">
              {initialsOf(user.name, user.email)}
            </AvatarFallback>
          </Avatar>
          <span className="hidden max-w-32 truncate text-sm font-medium lg:inline">
            {user.name}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-3 py-2.5">
          <Avatar className="size-9">
            {user.avatarUrl ? (
              <AvatarImage src={user.avatarUrl} alt={`Avatar de ${user.name}`} />
            ) : null}
            <AvatarFallback className="bg-emerald-500/15 text-xs font-bold text-emerald-300">
              {initialsOf(user.name, user.email)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{user.name}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => window.dispatchEvent(new Event('oe-open-settings'))}
          className="gap-2"
        >
          <Settings2 className="size-4" aria-hidden />
          Ajustes
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => void signOut()}
          className="gap-2"
        >
          <LogOut className="size-4" aria-hidden />
          Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
