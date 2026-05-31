import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Several route/auth suites intentionally mutate module-level env and
    // vi.mock state around dynamic imports; serial files keep the gate stable.
    fileParallelism: false,
  },
})
