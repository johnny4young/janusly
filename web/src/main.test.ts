import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// main.tsx is a boot script with side effects, so its composition is checked
// as text: the shell must sit under its own boundary, otherwise a throw in
// the chrome around the panels unmounts the whole document.
describe('shell boot', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/main.tsx'), 'utf8')

  it('renders App under a root ErrorBoundary with a visible fallback', () => {
    const boundary = source.indexOf('<ErrorBoundary logTag="shell"')
    const app = source.indexOf('<App />', boundary)
    const close = source.indexOf('</ErrorBoundary>', app)
    expect(boundary).toBeGreaterThan(-1)
    expect(app).toBeGreaterThan(boundary)
    expect(close).toBeGreaterThan(app)
    expect(source).toMatch(/fallback=\{\(\{ reset \}\) => <PanelErrorFallback onRetry=\{reset\} \/>\}/)
  })
})
