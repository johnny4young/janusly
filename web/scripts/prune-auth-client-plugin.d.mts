import type { Plugin } from 'vite'

export const AUTH_CLIENT_ROOTS: string[]

export function pruneAuthClass(
  code: string,
  className: 'GoTrueClient' | 'GoTrueAdminApi',
): { code: string; kept: string[]; removed: string[] }

export function pruneAuthClient(): Plugin
