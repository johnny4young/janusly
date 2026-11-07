import type { Plugin } from 'vite'

export const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string>

export function precompress(): Plugin

export function precompressDirectory(dir: string): Promise<number>
