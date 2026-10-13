/**
 * PM2 Ecosystem — OE AI (configuración permanente)
 * ─────────────────────────────────────────────────────────────
 * Uso:
 *   pm2 start ecosystem.config.js && pm2 save
 *   pm2 restart ecosystem.config.js --update-env
 *   pm2 resurrect   (tras un reboot del sandbox)
 *
 * Ventaja: el entorno de cada app se construye desde .env
 * (fuente única de verdad), así que las variables heredadas de
 * la shell (p. ej. DATABASE_URL=sqlite del reset del sandbox)
 * ya NO pueden corromper los procesos.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function loadDotEnv(file) {
  const env = {};
  try {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch (e) {
    console.error(`[ecosystem] No se pudo leer ${file}: ${e.message}`);
  }
  return env;
}

const dotEnv = loadDotEnv('.env');

module.exports = {
  apps: [
    {
      name: 'oe-ai-dev',
      cwd: ROOT,
      script: '/usr/local/bin/bun',
      args: 'run dev',
      env: { ...dotEnv, NODE_ENV: 'development' },
      out_file: '/tmp/oe-ai-dev.log',
      error_file: '/tmp/oe-ai-dev.err',
      time: true,
      max_restarts: 50,
      restart_delay: 3000,
      autorestart: true,
    },
    {
      name: 'oe-voice-ws',
      cwd: path.join(ROOT, 'mini-services/voice-service'),
      script: '/usr/local/bin/bun',
      args: '--hot index.ts',
      env: { ...dotEnv, NODE_ENV: 'development' },
      out_file: '/tmp/oe-voice-ws.log',
      error_file: '/tmp/oe-voice-ws.err',
      time: true,
      max_restarts: 50,
      restart_delay: 3000,
      autorestart: true,
    },
    {
      name: 'oe-telegram-bot',
      cwd: path.join(ROOT, 'mini-services/telegram-bot'),
      script: '/usr/local/bin/bun',
      args: '--hot index.ts',
      env: { ...dotEnv, NODE_ENV: 'development' },
      out_file: '/tmp/oe-telegram-bot.log',
      error_file: '/tmp/oe-telegram-bot.err',
      time: true,
      max_restarts: 50,
      restart_delay: 3000,
      autorestart: true,
    },
  ],
};
