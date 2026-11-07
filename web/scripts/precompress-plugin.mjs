/**
 * Write .br and .gz siblings for text files in the build output so the Go
 * server never compresses on a request. Siblings no smaller than the source are skipped.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

// Keep in sync with `compressible` in internal/webdist/webdist.go.
export const COMPRESSIBLE_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.map', '.mjs', '.svg', '.txt', '.webmanifest', '.xml',
])

const brotli = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

/** Compress every eligible file under `dir`; returns the written sibling count. */
export async function precompressDirectory(dir) {
  const files = (await listFiles(dir)).filter((file) => COMPRESSIBLE_EXTENSIONS.has(extname(file)))
  const written = await Promise.all(files.map(async (file) => {
    const source = await readFile(file)
    const [br, gz] = await Promise.all([
      brotli(source, {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
        },
      }),
      gzipAsync(source, { level: constants.Z_BEST_COMPRESSION }),
    ])
    let count = 0
    for (const [suffix, body] of [['.br', br], ['.gz', gz]]) {
      if (body.length >= source.length) continue
      await writeFile(file + suffix, body)
      count += 1
    }
    return count
  }))
  return written.reduce((sum, count) => sum + count, 0)
}

export function precompress() {
  let outDir = 'dist'
  return {
    name: 'janusly-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      await precompressDirectory(outDir)
    },
  }
}
