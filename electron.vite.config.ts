import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const DEV_CSP = [
  "default-src 'self'",
  // Vite injects the React Refresh preamble inline during development.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React writes a few inline style attributes (progress widths, terminal sizing).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'termforge:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const csp = context.server ? DEV_CSP : PRODUCTION_CSP
        return html.replace(
          '<!-- TERMFORGE_CSP -->',
          `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
        )
      },
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  },
})
