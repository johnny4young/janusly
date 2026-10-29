import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

// jest-dom still augments Vitest 4's one-parameter `Assertion`, which Vitest 5
// drops; both test setups register its matchers at runtime. Delete this file
// once jest-dom ships its own Vitest 5 `Matchers` augmentation.
declare module 'vitest' {
  interface Matchers<R, T> extends TestingLibraryMatchers<unknown, R> {}
}
