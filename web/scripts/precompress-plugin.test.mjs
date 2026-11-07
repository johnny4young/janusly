import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { precompressDirectory } from './precompress-plugin.mjs'

test('writes decodable siblings for text files only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'precompress-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'assets'))
  const script = 'export const value = "janusly";\n'.repeat(200)
  writeFileSync(join(dir, 'assets', 'app-abc.js'), script)
  writeFileSync(join(dir, 'assets', 'font-abc.woff2'), Buffer.alloc(4096, 7))
  writeFileSync(join(dir, 'tiny.svg'), '<svg/>')

  assert.equal(await precompressDirectory(dir), 2)
  assert.equal(brotliDecompressSync(readFileSync(join(dir, 'assets', 'app-abc.js.br'))).toString(), script)
  assert.equal(gunzipSync(readFileSync(join(dir, 'assets', 'app-abc.js.gz'))).toString(), script)
  assert.equal(existsSync(join(dir, 'assets', 'font-abc.woff2.gz')), false)
  assert.equal(existsSync(join(dir, 'tiny.svg.gz')), false, 'a sibling larger than its source is skipped')
})
