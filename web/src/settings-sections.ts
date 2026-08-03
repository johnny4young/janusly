import type { OpsSection } from './components/operations-section-bus'

export const SETTINGS_AREAS = [
  'reliability',
  'integrations',
  'access',
  'ai',
  'usage',
  'infrastructure',
] as const satisfies readonly Exclude<OpsSection, 'overview'>[]

const SETTINGS_SECTION_PERMISSIONS: Record<OpsSection, readonly string[]> = {
  overview: ['recovery.read'],
  reliability: ['alerts.read', 'upstream.read', 'dlq.read'],
  integrations: [
    'credentials.read',
    'credentials.write',
    'mcp.connections.read',
    'external-runtimes.read',
  ],
  access: ['members.read', 'org.config.write', 'recovery.read'],
  ai: ['recovery.read', 'org.config.write'],
  usage: ['recovery.read'],
  infrastructure: ['recovery.read'],
}

export function canOpenSettingsSection(
  section: OpsSection,
  permissions: readonly string[] | undefined,
): boolean {
  if (permissions === undefined) return true
  return SETTINGS_SECTION_PERMISSIONS[section].some((permission) =>
    permissions.includes(permission))
}
