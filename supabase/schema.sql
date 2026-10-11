-- ─────────────────────────────────────────────────────────────────────────────
-- OE AI · estructura para Supabase (proyecto xrtzzdfgyhfepqbaqskl)
--
-- Ejecutar en el SQL Editor de Supabase (Dashboard → SQL Editor → New query).
-- Prepara la tabla pública `profiles` para que los datos del usuario logueado
-- con Google (id, email, nombre, avatar) queden disponibles en la base de
-- datos de Supabase, con RLS activado (cada usuario solo ve su propia fila).
--
-- La app ya sincroniza contra esta tabla automáticamente tras el login
-- (upsert con la clave del usuario); mientras la tabla no exista, ese paso
-- se omite de forma silenciosa y la identidad queda guardada en el backend
-- local (SQLite/Prisma) vía /api/auth/sync.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Tabla de perfiles ---------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text,
  full_name     text,
  avatar_url    text,
  last_login_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is
  'Perfiles de OE AI sincronizados con Supabase Auth (Google OAuth).';

-- 2) Row Level Security: cada usuario gestiona SOLO su fila --------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 3) Creación automática del perfil al registrarse ------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4) Índice útil para búsquedas por email --------------------------------------
create unique index if not exists profiles_email_key on public.profiles (email);

-- ─────────────────────────────────────────────────────────────────────────────
-- Nota sobre la cadena de conexión PostgreSQL (migraciones/scripts del backend):
--   postgresql://postgres:[[TU_PASSWORD]]@db.xrtzzdfgyhfepqbaqskl.supabase.co:5432/postgres
-- Está guardada en .env como SUPABASE_DB_URL (solo servidor).
-- Desde este sandbox el puerto 5432 está bloqueado (verificado), por lo que la
-- app usa supabase-js por HTTPS (puerto 443) — verificado con auth/v1/health 200.
-- ─────────────────────────────────────────────────────────────────────────────
