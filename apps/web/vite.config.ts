/// <reference types="vitest" />
import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Real build stamp, computed once at config load: `<date>-<short-sha>`.
 * Replaces the hardcoded literal that went stale within weeks (fourth-wave
 * audit W-08). Falls back to "dev" outside a git checkout (e.g. a tarball
 * build) — an honest "dev" beats a confident wrong date.
 */
function buildId(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    return `${new Date().toISOString().slice(0, 10)}-${sha}`
  } catch {
    return 'dev'
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  server: {
    port: 5173,
  },
  build: {
    // Sourcemaps in dev + staging so error tracking + DX stay good; off in
    // production because inline .map files roughly double the JS bundle size
    // shipped to the browser on the first cold load. Future error-tracking
    // sidecar can flip this to 'hidden' to emit .map files without inlining.
    sourcemap: mode !== 'production',
    rollupOptions: {
      output: {
        manualChunks: (id) => {
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
    css: true,
  },
}))
