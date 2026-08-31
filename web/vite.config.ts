/// <reference types="vitest" />
import { execFileSync } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { compactI18nCatalogs } from './scripts/compact-i18n-plugin.mjs'
import { resolveWebTestWorkerLimit } from './vitest-worker-policy.js'

/**
 * Real build stamp, computed once at config load: `<date>-<short-sha>`.
 * Replaces a hardcoded literal that went stale within weeks. Falls back to
 * "dev" outside a git checkout (e.g.
 * a tarball build) — an honest "dev" beats a confident wrong date.
 */
function buildId(): string {
  const explicit = process.env.JANUSLY_BUILD_ID?.trim()
  if (explicit) return explicit
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    return `${new Date().toISOString().slice(0, 10)}-${sha}`
  } catch {
    return 'dev'
  }
}

const apiRoutePattern = '^/(?:v1|health|auth|ai|workflows|runs|run|start|status|cancel|resume|dlq|validate|org|organizations|members|roles|credentials|mcp|recovery|auto-healing|reports|billing|usage|memory|triggers|webhooks|pagerduty|solution-packs|templates|packs|plugins|snippets|onboarding|users|eval|experiments|causal|system|prompts|audit|scim|upstream|integrations|tools|directories|browser-session|identity|sso|external-runtime|rollouts|alerts|replay)(?:/|$|\\?)'

export default defineConfig(({ mode }) => ({
  plugins: [
    compactI18nCatalogs({
      canonicalPath: resolve(import.meta.dirname, 'src/i18n/locales/en/common.json'),
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      [apiRoutePattern]: {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
  build: {
    // Sourcemaps in dev + staging so error tracking + DX stay good; off in
    // production because inline .map files roughly double the JS bundle size
    // shipped to the browser on the first cold load. Future error-tracking
    // sidecar can flip this to 'hidden' to emit .map files without inlining.
    sourcemap: mode !== 'production',
    cssMinify: 'lightningcss',
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (
            id.endsWith('/src/i18n/catalog-keys.ts')
            || id.includes('janusly-catalog=keys')
          ) {
            return 'catalog-keys'
          }
          if (id.includes('/i18n/catalog-core-en') || id.includes('/i18n/catalog-workspace-en')) {
            return 'catalog-en'
          }
          if (id.includes('/i18n/catalog-core-es') || id.includes('/i18n/catalog-workspace-es')) {
            return 'catalog-es'
          }
          if (
            id.endsWith('/src/App.tsx')
            || id.endsWith('/src/AppWorkspace.tsx')
            || id.includes('/src/hooks/app-command')
            || id.includes('/src/hooks/useApp')
            || id.endsWith('/src/hooks/useIdentityBootstrap.ts')
            || id.endsWith('/src/hooks/useIntegrationCommands.ts')
            || id.endsWith('/src/hooks/useRunCommands.ts')
            || id.endsWith('/src/hooks/useWorkflowCommands.ts')
            || id.endsWith('/src/lib/text-search.ts')
            || id.endsWith('/src/components/RecoveryCenterPanel.tsx')
            || id.endsWith('/src/components/RecoveryCenterView.tsx')
          ) {
            return 'app-workspace'
          }
          if (
            id.endsWith('/src/components/RightPanel.tsx')
            || id.endsWith('/src/components/WorkflowsDashboard.tsx')
            || id.endsWith('/src/components/WorkflowsDashboardView.tsx')
            || id.endsWith('/src/components/workflows-dashboard-model.ts')
            || id.endsWith('/src/components/WorkflowOperationsPanel.tsx')
            || id.endsWith('/src/components/input-display-label.ts')
          ) {
            return 'workflow-workspace'
          }
          if (!id.includes('node_modules')) return undefined
          // `@xyflow/*` is reached ONLY through the dynamic `CanvasWorkspace`
          // import (nothing on the boot path imports an `@xyflow` value — the
          // store registers React Flow's change-appliers lazily from that
          // chunk and `canvas-projections` uses the marker string literal), so
          // leaving it unforced lets Rolldown keep the renderer in that
          // on-demand chunk. The early return is REQUIRED so the `/react/`
          // matcher below doesn't sweep `@xyflow/react` into the eager
          // react-vendor bundle.
          if (id.includes('@xyflow/')) return undefined
          if (id.includes('lucide-react')) return 'icons-vendor'
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) return 'react-vendor'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/**/*.browser.test.{ts,tsx}', 'node_modules/**'],
    // Each file owns a jsdom realm and may activate several lazy Vite imports.
    // Keep file concurrency, but cap aggregate realm/import pressure so test
    // deadlines measure component behavior rather than host scheduler delay.
    fileParallelism: true,
    maxWorkers: resolveWebTestWorkerLimit(availableParallelism()),
    css: true,
  },
}))
