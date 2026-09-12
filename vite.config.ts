/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/**
 * The shared Stoatworks footer, and with it the "report a bug" button.
 *
 * The desktop app is built from this same config — `tauri build` runs this
 * very file — so the injection is gated rather than hung off a separate hosted
 * config. Tauri 2 sets TAURI_ENV_PLATFORM for its own invocations and a plain
 * `vite build` does not, which is the only thing here that distinguishes the
 * two. The footer's feedback button posts to the intake host, which the
 * hosted CSP in public/_headers allows and the desktop CSP does not need.
 */
function supportFooter(): Plugin | false {
  if (process.env.TAURI_ENV_PLATFORM) return false
  return {
    name: 'stoatworks-support-footer',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          {
            tag: 'script',
            injectTo: 'body',
            attrs: {
              src: '/support-footer.js',
              defer: true,
              'data-app': 'OpenFont Manager',
              'data-repo': 'https://github.com/stoatworks-labs/openfont-manager',
              'data-version': `v${pkg.version}`,
              'data-note':
                'It runs entirely in your browser — the only servers it talks to are the two font CDNs.',
            },
          },
        ]
      },
    },
  }
}

// Static SPA, no backend. dist/ is what a static host serves, and what the
// Tauri desktop build embeds — `tauri build` runs this same config.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react(), supportFooter()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
  },
})
