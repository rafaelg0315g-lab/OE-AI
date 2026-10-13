#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# restore-server.sh — Recuperación automática del entorno OE AI
# ─────────────────────────────────────────────────────────────
# Revierte los efectos de un reset del sandbox:
#   1. Reinstala PM2 si falta (npm i -g pm2)
#   2. Restaura .env si fue reseteado (detecta sqlite)
#   3. Levanta los 3 servicios (pm2 resurrect → fallback ecosystem)
#   4. Guarda el dump (pm2 save)
#
# Uso manual:   bash /home/z/my-project/scripts/restore-server.sh
# Auto:         se llama desde ~/.bashrc si PM2 no está corriendo
# ─────────────────────────────────────────────────────────────
set -u
ROOT="/home/z/my-project"
LOG_TAG="[oe-restore]"

log() { echo "$LOG_TAG $*"; }

# ── 1. PM2 presente ──────────────────────────────────────────
if ! command -v pm2 >/dev/null 2>&1; then
  log "PM2 no encontrado → instalando (npm i -g pm2)…"
  npm i -g pm2 >/dev/null 2>&1 || { log "ERROR: no se pudo instalar PM2"; exit 1; }
  log "PM2 $(pm2 -v) instalado"
fi

# ── 2. .env sano (DATABASE_URL debe ser postgres pooler) ─────────────────────
# NOTA: las credenciales reales NO viven en este script (están prohibidas en
# git por push protection). El propietario guarda la plantilla real fuera del
# repo (p. ej. ~/.oe-env-backup). Si .env está roto y existe ese backup, se
# restaura desde él; si no, se avisa y se aborta la reparación del .env.
ENV_FILE="$ROOT/.env"
ENV_BACKUP="$HOME/.oe-env-backup"
if ! rg -q '^DATABASE_URL=postgresql://' "$ENV_FILE" 2>/dev/null; then
  if [ -f "$ENV_BACKUP" ] && rg -q '^DATABASE_URL=postgresql://' "$ENV_BACKUP"; then
    log ".env roto o reseteado → restaurando desde $ENV_BACKUP…"
    cp "$ENV_BACKUP" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log ".env restaurado"
  else
    log "AVISO: .env roto y no existe backup en $ENV_BACKUP."
    log "Restaura manualmente el .env (DATABASE_URL de Supabase + keys) y reintenta."
  fi
fi

# ── 2b. Dependencias de mini-servicios (el reset borra node_modules) ──
for svc in "$ROOT/mini-services/voice-service" "$ROOT/mini-services/telegram-bot"; do
  if [ ! -d "$svc/node_modules" ]; then
    log "node_modules de $(basename "$svc") falta → bun install…"
    (cd "$svc" && bun install >/dev/null 2>&1)
  fi
done

# ── 3. Levantar servicios ────────────────────────────────────
if pm2 list 2>/dev/null | rg -q 'oe-ai-dev.*online'; then
  log "PM2 ya está corriendo — nada que hacer"
  exit 0
fi

if pm2 resurrect 2>/dev/null && pm2 list 2>/dev/null | rg -q 'oe-ai-dev'; then
  log "Servicios restaurados desde dump (pm2 resurrect)"
else
  log "Sin dump válido → arrancando desde ecosystem.config.js…"
  cd "$ROOT" && pm2 start ecosystem.config.js
  log "Servicios arrancados desde ecosystem"
fi

pm2 save >/dev/null 2>&1
log "Estado guardado (pm2 save). Servicios: app :3000 · voz :3010 · telegram :3005"
