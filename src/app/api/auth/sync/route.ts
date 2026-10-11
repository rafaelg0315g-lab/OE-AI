import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * POST /api/auth/sync — persiste la identidad del usuario logueado
 * (Google o GitHub, OAuth vía Supabase).
 *
 * Seguridad: NO se confía en los datos del cliente. Solo se recibe el
 * access token de Supabase; el servidor lo valida contra
 * `GET {SUPABASE_URL}/auth/v1/user` y guarda la identidad VERIFICADA
 * (id, email, nombre, avatar) en Prisma/SQLite.
 */
const BodySchema = z.object({
  accessToken: z.string().min(10).max(4096),
})

type SupabaseAuthUser = {
  id?: string
  email?: string | null
  app_metadata?: { provider?: string; providers?: string[] }
  user_metadata?: Record<string, unknown>
}

export async function POST(req: Request) {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!projectUrl || !anonKey) {
    return NextResponse.json(
      { ok: false, error: 'supabase_not_configured' },
      { status: 503 },
    )
  }

  // 1) Validar el cuerpo
  let accessToken: string
  try {
    const parsed = BodySchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 })
    }
    accessToken = parsed.data.accessToken
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  // 2) Verificar el token contra Supabase Auth (fuente de verdad)
  let authUser: SupabaseAuthUser
  try {
    const res = await fetch(`${projectUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    })
    if (res.status === 401 || res.status === 403) {
      // 401 unauthorized · 403 bad_jwt (token malformado o expirado)
      return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 401 })
    }
    if (!res.ok) {
      console.warn('[auth/sync] Supabase respondió', res.status)
      return NextResponse.json(
        { ok: false, error: 'supabase_unreachable' },
        { status: 502 },
      )
    }
    authUser = (await res.json()) as SupabaseAuthUser
  } catch (err) {
    console.warn('[auth/sync] red hacia Supabase falló:', err)
    return NextResponse.json({ ok: false, error: 'network_error' }, { status: 502 })
  }

  if (!authUser?.id) {
    return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 401 })
  }

  // 3) Upsert de la identidad verificada
  const meta = authUser.user_metadata ?? {}
  const metaString = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = meta[k]
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 255)
    }
    return null
  }
  // GitHub puede autenticar usuarios sin email público (toggle "Allow users
  // without an email"): Supabase entrega un email sintético noreply, pero si
  // faltara sintetizamos uno determinista y único (el id del usuario es
  // verificado por el token; el login de GitHub también es único).
  const githubLogin = metaString('user_name')
  const email =
    authUser.email?.trim() ||
    (githubLogin ? `${githubLogin}@users.noreply.github.com` : `${authUser.id}@users.noreply.github.com`)
  const name = metaString('full_name', 'name', 'display_name', 'user_name')
  const avatarUrl = metaString('avatar_url', 'picture')

  try {
    const user = await db.supabaseUser.upsert({
      where: { supabaseId: authUser.id },
      update: { email, name, avatarUrl, lastLoginAt: new Date() },
      create: { supabaseId: authUser.id, email, name, avatarUrl },
    })
    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        lastLoginAt: user.lastLoginAt,
      },
    })
  } catch (err) {
    console.warn('[auth/sync] upsert falló:', err)
    return NextResponse.json({ ok: false, error: 'sync_failed' }, { status: 500 })
  }
}

/**
 * GET /api/auth/sync — estado de la sincronización (sin datos personales):
 * total de usuarios verificados y fecha del último inicio de sesión.
 */
export async function GET() {
  try {
    const total = await db.supabaseUser.count()
    const last = await db.supabaseUser.findFirst({
      orderBy: { lastLoginAt: 'desc' },
      select: { lastLoginAt: true },
    })
    return NextResponse.json({ ok: true, total, lastLoginAt: last?.lastLoginAt ?? null })
  } catch {
    return NextResponse.json({ ok: false, error: 'query_failed' }, { status: 500 })
  }
}
