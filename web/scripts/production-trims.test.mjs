import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'vite'
import { unwrapColorMixSupports } from './css-floor-plugin.mjs'
import { AUTH_CLIENT_ROOTS, pruneAuthClass, pruneAuthClient } from './prune-auth-client-plugin.mjs'
import { reactEsmFacade } from './react-esm-facade-plugin.mjs'
import { trimVendor } from './trim-vendor-plugin.mjs'

const require = createRequire(import.meta.url)
const WEB_ROOT = resolve(import.meta.dirname, '..')
const XYFLOW_SYSTEM = realpathSync(join(realpathSync(join(WEB_ROOT, 'node_modules/@xyflow/react')), '../system'))
const outDir = mkdtempSync(join(WEB_ROOT, 'node_modules/.janusly-production-trims-'))
const AUTH_MODULE_DIR = join(realpathSync(join(WEB_ROOT, 'node_modules/@supabase/auth-js')), 'dist/module')
const ENTRY = join(outDir, 'entry.mjs')
writeFileSync(ENTRY, `
export { GoTrueClient } from '@supabase/auth-js'
export { XYPanZoom } from ${JSON.stringify(XYFLOW_SYSTEM)}
export { Bot } from 'lucide-react'
`)

async function bundle(name, plugins) {
  await build({
    configFile: false,
    root: WEB_ROOT,
    logLevel: 'silent',
    plugins,
    build: {
      outDir: join(outDir, name),
      minify: false,
      lib: { entry: ENTRY, formats: ['es'], fileName: () => 'entry.mjs' },
      rollupOptions: { external: ['react', 'react/jsx-runtime'] },
    },
  })
  return import(pathToFileURL(join(outDir, name, 'entry.mjs')).href)
}

function installBrowser(url) {
  const dom = new JSDOM('<!doctype html><div id="pane"></div>', { url, pretendToBeVisual: true })
  const { window } = dom
  for (const name of ['window', 'document', 'localStorage', 'Element', 'Node', 'requestAnimationFrame']) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: window[name] })
  }
  return dom
}

let trimmed
let original

before(async () => {
  trimmed = await bundle('trimmed', [trimVendor(), pruneAuthClient()])
  original = await bundle('original', [])
})
after(() => rmSync(outDir, { recursive: true, force: true }))

const AUTH_USER = { id: 'user-1', aud: 'authenticated', email: 'a@example.test' }
const authSession = (token) => ({
  access_token: token,
  refresh_token: `${token}-refresh`,
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: AUTH_USER,
})
const authJson = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})
const URL_SESSION = 'access_token=from-url&refresh_token=r&expires_in=3600&token_type=bearer&expires_at=9999999999'
const callbackToken = (exp) => [{ alg: 'HS256' }, { sub: 'user-1', exp }, 'sig']
  .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')
const LIVE_CALLBACK = callbackToken(9999999999)
const AUTH_SCENARIOS = {
  'password session lifecycle': {},
  'session in the URL': { url: `https://app.example.test/#${URL_SESSION}` },
  'approved callback': { callback: LIVE_CALLBACK },
  'approved expired callback': { callback: callbackToken(1) },
  'callback the server rejects': { callback: LIVE_CALLBACK, user: () => authJson({ msg: 'bad jwt' }, 401) },
  'callback whose session ended': { callback: LIVE_CALLBACK, user: () => authJson({ error_code: 'session_not_found', msg: 'gone' }, 403) },
  'malformed callback': { callback: 'not-a-jwt' },
  'error in the URL': { url: 'https://app.example.test/#error=access_denied&error_code=otp_expired&error_description=expired' },
  'code under the implicit flow': { url: 'https://app.example.test/?code=abc' },
  'hash route': { url: 'https://app.example.test/#/home' },
  'rejected refresh': { refresh: () => authJson({ error_code: 'refresh_token_not_found', msg: 'gone' }, 400) },
  'failing refresh': { refresh: () => authJson({ msg: 'unavailable' }, 500) },
  'unreachable refresh': { refresh: () => { throw new TypeError('Failed to fetch') } },
  'rejected password': { password: () => authJson({ error_code: 'invalid_credentials', msg: 'bad' }, 400) },
  'signup awaiting confirmation': { signup: () => authJson(AUTH_USER) },
  'weak signup password': { signup: () => authJson({ error_code: 'weak_password', msg: 'weak' }, 422) },
  'rejected password update': { updatePassword: () => authJson({ error_code: 'same_password', msg: 'same' }, 422) },
  'password update for an ended session': { updatePassword: () => authJson({ error_code: 'session_not_found', msg: 'gone' }, 403) },
  'unreachable password update': { updatePassword: () => { throw new TypeError('Failed to fetch') } },
  'rejected logout': { logout: () => authJson({ msg: 'forbidden' }, 403) },
  'failing logout': { logout: () => authJson({ msg: 'unavailable' }, 500) },
}

function comparable(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (item instanceof Error) return { name: item.name, message: item.message, status: item.status, code: item.code }
    return key === 'expires_at' || key === 'expires_in' ? undefined : item
  }))
}

let authRuns = 0

// Uses the options of src/supabase-runtime.ts; only retry backoff is shortened.
async function exerciseAuth(GoTrueClient, scenario) {
  const calls = []
  const events = []
  const dom = installBrowser(scenario.url ?? 'https://app.example.test/')
  const { setTimeout: realSetTimeout } = globalThis
  globalThis.setTimeout = (callback, delay, ...rest) => realSetTimeout(callback, Math.min(delay ?? 0, 20), ...rest)
  const storageKey = `sb-test-${authRuns += 1}-auth-token`
  const client = new GoTrueClient({
    url: 'https://auth.example.test/auth/v1',
    headers: { Authorization: 'Bearer key', apikey: 'key' },
    storageKey,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'implicit',
    fetch: async (url, init = {}) => {
      const { pathname, search } = new URL(url)
      calls.push(`${init.method ?? 'GET'} ${pathname}${search}`)
      if (pathname.endsWith('/signup')) return scenario.signup?.() ?? authJson(authSession('signup'))
      if (search.includes('grant_type=password')) return scenario.password?.() ?? authJson(authSession('password'))
      if (search.includes('grant_type=refresh_token')) return scenario.refresh?.() ?? authJson(authSession('refreshed'))
      if (pathname.endsWith('/logout')) return scenario.logout?.() ?? new Response(null, { status: 204 })
      if (pathname.endsWith('/user') && init.method === 'PUT') return scenario.updatePassword?.() ?? authJson(AUTH_USER)
      if (pathname.endsWith('/user')) return scenario.user?.() ?? authJson(AUTH_USER)
      return authJson({ msg: 'unexpected' }, 500)
    },
  })
  const { data: listener } = client.onAuthStateChange((event, session) => {
    events.push([event, session?.access_token ?? null])
  })
  const fromUrl = comparable(await client.getSession())
  const adopted = scenario.callback
    ? comparable(await client.setSession({ access_token: scenario.callback, refresh_token: 'r' }))
    : null
  document.dispatchEvent(new window.Event('visibilitychange'))
  const signUp = comparable(await client.signUp({ email: 'a@example.test', password: 'pw-12345' }))
  const signIn = comparable(await client.signInWithPassword({ email: 'a@example.test', password: 'pw-12345' }))
  const updatePassword = comparable(await client.updateUser({ password: 'pw-67890' }).catch((error) => error))
  const stored = window.localStorage.getItem(storageKey)
  if (stored) window.localStorage.setItem(storageKey, JSON.stringify({ ...JSON.parse(stored), expires_at: 1 }))
  const afterExpiry = comparable(await client.getSession())
  const signOut = comparable(await client.signOut())
  const afterSignOut = comparable(await client.getSession())
  await new Promise((done) => realSetTimeout(done, 20))
  listener.subscription.unsubscribe()
  const result = {
    fromUrl,
    adopted,
    signUp,
    signIn,
    updatePassword,
    afterExpiry,
    signOut,
    afterSignOut,
    remaining: window.localStorage.getItem(storageKey),
    href: window.location.href,
    calls,
    events,
  }
  await client.signOut({ scope: 'local' })
  globalThis.setTimeout = realSetTimeout
  dom.window.close()
  return result
}

test('the auth facade type and the pruning roots list the same methods', () => {
  const source = readFileSync(join(WEB_ROOT, 'src/auth.ts'), 'utf8')
  const facade = /Pick<\s*GoTrueClient,([^>]+)>/.exec(source)
  assert.ok(facade)
  assert.deepEqual([...facade[1].matchAll(/'(\w+)'/g)].map((match) => match[1]).sort(), [...AUTH_CLIENT_ROOTS].sort())
})

test('auth pruning keeps session code and removes unused surfaces', () => {
  const code = readFileSync(join(AUTH_MODULE_DIR, 'GoTrueClient.js'), 'utf8')
  const { kept, removed } = pruneAuthClass(code, 'GoTrueClient')
  assert.ok(kept.includes('setSession'))
  assert.ok(kept.includes('updateUser'))
  assert.ok(kept.includes('_refreshAccessToken'))
  assert.ok(removed.includes('signInWithOAuth'))
  const admin = readFileSync(join(AUTH_MODULE_DIR, 'GoTrueAdminApi.js'), 'utf8')
  assert.deepEqual(pruneAuthClass(admin, 'GoTrueAdminApi').kept, ['constructor', 'signOut'])
})

const syntheticClient = (member) => `class GoTrueClient {
  ${member}
  constructor() {}
  onAuthStateChange() {}
  setSession() {}
  signInWithPassword() {}
  signOut() {}
  signUp() {}
  updateUser() {}
  unused() {}
}`

for (const [name, member, expected] of [
  ['a removed cluster', 'getSession() { this.mfa.enroll() }', /needs this\.mfa/],
  ['a removed delegate method', 'getSession() { this.admin.getUserById() }', /needs this\.admin\.getUserById/],
  ['a computed delegate method', "getSession() { this.admin['signOut']() }", /needs this\.admin/],
  ['an aliased delegate', 'getSession() { const admin = this.admin; admin.getUserById() }', /uses this\.admin directly/],
  ['an aliased this', 'getSession() { const self = this; self.unused() }', /uses this indirectly/],
  ['a destructured this', 'getSession() { const { unused } = this; unused() }', /uses this indirectly/],
  ['computed access', "getSession() { this['unused']() }", /uses this indirectly/],
  ['this as an argument', 'getSession() { helper(this) }', /uses this indirectly/],
  ['this bound to a helper', 'getSession() { helper.bind(this) }', /uses this indirectly/],
]) {
  test(`auth pruning fails the build on ${name}`, () => {
    assert.throws(() => pruneAuthClass(syntheticClient(member), 'GoTrueClient'), expected)
  })
}

for (const [name, member] of [
  ['a class field', 'callback = () => this.unused()'],
  ['a computed method', '[Symbol.iterator]() { return this.unused() }'],
  ['a static method', 'static build() { return this.unused() }'],
]) {
  test(`auth pruning keeps what ${name} reaches`, () => {
    const source = syntheticClient(`getSession() {}\n  ${member}`)
    assert.ok(pruneAuthClass(source, 'GoTrueClient').kept.includes('unused'))
  })
}

// An open channel would keep the test process alive, so each run closes its own.
async function withChannel(channel, run) {
  const { BroadcastChannel: nativeChannel } = globalThis
  const opened = []
  globalThis.BroadcastChannel = channel
    ? class extends nativeChannel { constructor(name) { super(name); opened.push(this) } }
    : undefined
  try {
    return await run()
  } finally {
    for (const openChannel of opened) openChannel.close()
    globalThis.BroadcastChannel = nativeChannel
  }
}

for (const channel of [true, false]) {
  for (const [name, scenario] of Object.entries(AUTH_SCENARIOS)) {
    test(`pruned auth client matches the original: ${name}, ${channel ? 'with' : 'without'} BroadcastChannel`, () => (
      withChannel(channel, async () => {
        assert.deepEqual(await exerciseAuth(trimmed.GoTrueClient, scenario), await exerciseAuth(original.GoTrueClient, scenario))
      })
    ))
  }
}

test('pruned auth client signs in, adopts an approved callback and ignores the URL', () => withChannel(true, async () => {
  const inUrl = await exerciseAuth(trimmed.GoTrueClient, AUTH_SCENARIOS['session in the URL'])
  assert.equal(inUrl.fromUrl.data.session, null)
  const approved = await exerciseAuth(trimmed.GoTrueClient, AUTH_SCENARIOS['approved callback'])
  assert.equal(approved.adopted.data.session.access_token, LIVE_CALLBACK)
  const lifecycle = await exerciseAuth(trimmed.GoTrueClient, AUTH_SCENARIOS['password session lifecycle'])
  assert.equal(lifecycle.signIn.data.session.access_token, 'password')
  assert.equal(lifecycle.afterExpiry.data.session.access_token, 'refreshed')
  assert.equal(lifecycle.afterSignOut.data.session, null)
  assert.ok(lifecycle.calls.some((call) => call.includes('/logout')))
}))

test('stubbed d3-color still runs animated and linear React Flow zoom transitions', async () => {
  const dom = installBrowser('https://app.example.test/')
  const { XYPanZoom } = trimmed
  const domNode = document.getElementById('pane')
  const panZoom = XYPanZoom({
    domNode,
    minZoom: 0.1,
    maxZoom: 4,
    translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
    viewport: { x: 0, y: 0, zoom: 1 },
    paneClickDistance: 0,
    onDraggingChange: () => undefined,
    onPanZoomStart: () => undefined,
    onPanZoom: () => undefined,
    onPanZoomEnd: () => undefined,
  })
  for (const interpolate of ['smooth', 'linear']) {
    const target = { x: interpolate === 'smooth' ? 40 : 10, y: 20, zoom: 2 }
    await panZoom.setViewport(target, { duration: 30, interpolate })
    assert.deepEqual(panZoom.getViewport(), target)
  }
  panZoom.destroy()
  dom.window.close()
})

test('lucide icons lose only their React keys', () => {
  const output = readFileSync(join(outDir, 'trimmed', 'entry.mjs'), 'utf8')
  const untouched = readFileSync(join(outDir, 'original', 'entry.mjs'), 'utf8')
  assert.ok(untouched.includes('hb8ula'))
  assert.ok(output.includes('M12 8V4H8'))
  assert.ok(!output.includes('hb8ula'))
})

test('color-mix guards unwrap without touching other at-rules', () => {
  const css = '.a{color:red;@supports (color: color-mix(in lab, red, red)){color:color-mix(in srgb, red 5%, blue);}}'
    + '@supports (display:grid){.b{display:grid}}'
  assert.equal(
    unwrapColorMixSupports(css),
    '.a{color:red;color:color-mix(in srgb, red 5%, blue);}@supports (display:grid){.b{display:grid}}',
  )
})

test('react facade only intercepts ESM importers', () => {
  const plugin = reactEsmFacade()
  assert.equal(plugin.resolveId('react', '/x/node_modules/react-dom/client.js'), null)
  assert.equal(plugin.resolveId('react', '/x/node_modules/use-sync-external-store/shim.js'), null)
  assert.equal(plugin.resolveId('react', '\0janusly-esm:react'), null)
  assert.match(plugin.resolveId('react/jsx-runtime', '/x/src/App.tsx').id, /janusly-esm/)
  const facade = plugin.load('\0janusly-esm:react')
  for (const name of Object.keys(require('react'))) {
    assert.ok(facade.includes(`export const ${name} = real.${name}`), name)
  }
  assert.match(facade, /export default real/)
})
