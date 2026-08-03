import { t } from './runtime'

export function tToolInputLabel(name: string, fallback: string): string {
  return t(`toolFields.${name}.label`, { defaultValue: fallback })
}
