/**
 * TypeScript module augmentation for i18next. By telling i18next the shape
 * of our resource catalogue at compile time, every `t('some.key')` call
 * autocompletes from the en JSON and unknown keys are a compile error
 * (the i18next-native type-safety story; see https://i18next.com/overview/typescript).
 *
 * Single source of truth: `apps/web/src/i18n/locales/en/common.json`.
 * `es/common.json` parity is enforced at runtime via `parity.test.ts`.
 */

import 'i18next'
import type enCommon from './locales/en/common.json'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: { common: typeof enCommon }
  }
}
