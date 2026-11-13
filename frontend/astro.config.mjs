// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// Allow running from a fresh clone with only the repo-root `.env`, while keeping OS env vars and `frontend/.env*` higher priority.
function applyRootPublicEnvFallback() {
  const frontendDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = resolve(frontendDir, '..');
  const mode = process.argv.includes('build')
    ? 'production'
    : process.env.NODE_ENV || 'development';
  const files = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];

  /** @param {string} dir */
  const readPublicKeys = (dir) => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const file of files) {
      const fullPath = resolve(dir, file);
      if (!existsSync(fullPath)) continue;
      const content = readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = parseEnv(content);
      for (const [k, v] of Object.entries(parsed)) {
        if (k.startsWith('PUBLIC_') && typeof v === 'string') {
          out[k] = v;
        }
      }
    }
    return out;
  };

  const rootPublic = readPublicKeys(rootDir);
  const frontendPublic = readPublicKeys(frontendDir);

  for (const [k, v] of Object.entries(rootPublic)) {
    if (process.env[k] === undefined && !(k in frontendPublic)) {
      process.env[k] = v;
    }
  }
}

applyRootPublicEnvFallback();

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  server: {
    port: 4321,
    host: true,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      port: 4321,
      host: true,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
  },
});
