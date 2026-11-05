/**
 * The subset of `zod/mini` the browser's live validators use, without Zod's
 * runtime cost. Same call shape, so a schema module swaps only its import.
 * Modules that production never reaches keep real Zod; a differential test
 * holds this subset to Zod's accept/reject and output behavior.
 */

import { isRecord } from './guards'

type Issue = { path: PropertyKey[]; message: string; code?: string }
type Outcome<T> = { value: T; issues: Issue[] }
type Check<T> = (outcome: Outcome<T>) => void
export type SafeParseResult<T> =
  | { success: true; data: T; error?: undefined }
  | { success: false; data?: undefined; error: { issues: Issue[] } }

export interface Schema<T> {
  run(input: unknown): Outcome<T>
  fillsUndefined?: boolean
  check(...checks: Check<T>[]): this
  safeParse(input: unknown): SafeParseResult<T>
}
export type OptionalSchema<T> = Schema<T | undefined> & { optionalKey: true }
export type ObjectSchema<S extends Shape, T> = Schema<T> & { shape: S }
type Shape = Record<string, Schema<unknown>>
type OptionalKeys<S> = { [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never }[keyof S]
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type Out<S> = S extends Schema<infer T> ? T : never
export type { Out as infer }
type ObjectOutput<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Out<S[K]> }
  & { [K in OptionalKeys<S>]?: Out<S[K]> }
>
export type RefinementContext = { addIssue(issue: Issue & { code: string }): void }

function fail<T>(message: string, input: unknown): Outcome<T> {
  return { value: input as T, issues: [{ path: [], message }] }
}

function prefix(key: PropertyKey, issues: Issue[]): Issue[] {
  return issues.map((issue) => ({ ...issue, path: [key, ...issue.path] }))
}

function schema<T, X extends object = object>(run: (input: unknown) => Outcome<T>, extra?: X): Schema<T> & X {
  const base: Schema<T> = {
    run,
    check(...checks) {
      return schema((input) => {
        const outcome = run(input)
        if (outcome.issues.length === 0) for (const check of checks) check(outcome)
        return outcome
      }, extra) as typeof this
    },
    safeParse(input) {
      const { value, issues } = run(input)
      return issues.length === 0 ? { success: true, data: value } : { success: false, error: { issues } }
    },
  }
  return Object.assign(base, extra)
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (!isRecord(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === null || prototype === Object.prototype
}

const valid = <T>(value: unknown): Outcome<T> => ({ value: value as T, issues: [] })
const typed = <T>(accepts: (input: unknown) => boolean, expected: string) => schema<T>((input) => (
  accepts(input) ? valid<T>(input) : fail<T>(`Expected ${expected}`, input)
))

export const string = () => typed<string>((input) => typeof input === 'string', 'string')
export const boolean = () => typed<boolean>((input) => typeof input === 'boolean', 'boolean')
export const unknown = () => schema<unknown>(valid)
export const int = () => typed<number>(Number.isSafeInteger, 'integer')

export function literal<const T>(expected: T): Schema<T> {
  return typed<T>((input) => input === expected, String(expected))
}

function _enum<const T extends readonly unknown[]>(values: T): Schema<T[number]> {
  return typed<T[number]>((input) => values.includes(input), 'enum value')
}
export { _enum as enum }

export function union<const T extends readonly Schema<unknown>[]>(options: T): Schema<Out<T[number]>> {
  return schema<Out<T[number]>>((input) => {
    for (const option of options) {
      const outcome = option.run(input)
      if (outcome.issues.length === 0) return outcome as Outcome<Out<T[number]>>
    }
    return fail('Invalid input', input)
  })
}

export function discriminatedUnion<const T extends readonly Schema<unknown>[]>(
  _key: string,
  options: T,
): Schema<Out<T[number]>> {
  return union(options)
}

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return schema<T | undefined, { optionalKey: true }>(
    (input) => (input === undefined && !inner.fillsUndefined ? valid(undefined) : inner.run(input)),
    { optionalKey: true },
  )
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return schema<T | null, Pick<Schema<T>, 'fillsUndefined'>>(
    (input) => (input === null ? valid(null) : inner.run(input)),
    { fillsUndefined: inner.fillsUndefined },
  )
}

export function _default<T>(inner: Schema<T>, fallback: T): Schema<T> {
  return schema<T, Pick<Schema<T>, 'fillsUndefined'>>((input) => {
    if (input !== undefined) return inner.run(input)
    if (Array.isArray(fallback)) return valid([...fallback])
    return valid(isRecord(fallback) ? { ...fallback } : fallback)
  }, { fillsUndefined: true })
}

export function lazy<T>(getter: () => Schema<T>): Schema<T> {
  return schema<T>((input) => getter().run(input))
}

export function array<T>(element: Schema<T>): Schema<T[]> {
  return schema<T[]>((input) => {
    if (!Array.isArray(input)) return fail('Expected array', input)
    const outcomes = Array.from(input, (item) => element.run(item))
    return {
      value: outcomes.map((outcome) => outcome.value),
      issues: outcomes.flatMap((outcome, index) => prefix(index, outcome.issues)),
    }
  })
}

/** Unlike Zod, an enum key schema does not require every key to be present. */
export function record<T>(keySchema: Schema<string>, value: Schema<T>): Schema<Record<string, T>> {
  return schema<Record<string, T>>((input) => {
    if (!isPlainRecord(input)) return fail('Expected record', input)
    const output: Record<string, T> = {}
    const issues: Issue[] = []
    for (const key of Object.keys(input)) {
      if (key === '__proto__') continue
      issues.push(...keySchema.run(key).issues.map((issue) => ({ ...issue, path: [key] })))
      const outcome = value.run(input[key])
      output[key] = outcome.value
      issues.push(...prefix(key, outcome.issues))
    }
    return { value: output, issues }
  })
}

function objectSchema<S extends Shape>(shape: S, strict: boolean): ObjectSchema<S, ObjectOutput<S>> {
  return schema<ObjectOutput<S>, { shape: S }>((input) => {
    if (!isRecord(input)) return fail('Expected object', input)
    const output: Record<string, unknown> = {}
    const issues: Issue[] = []
    for (const key of Object.keys(shape)) {
      const outcome = shape[key]!.run(input[key])
      issues.push(...prefix(key, outcome.issues))
      if (outcome.value !== undefined || key in input) output[key] = outcome.value
    }
    if (strict) {
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(shape, key)) issues.push({ path: [key], message: 'Unrecognized key' })
      }
    }
    return { value: output as ObjectOutput<S>, issues }
  }, { shape })
}

export const object = <S extends Shape>(shape: S) => objectSchema(shape, false)
export const strictObject = <S extends Shape>(shape: S) => objectSchema(shape, true)

type WithLength = { length: number }

export const minLength = <T extends WithLength>(minimum: number): Check<T> => (outcome) => {
  if (outcome.value.length < minimum) outcome.issues.push({ path: [], message: `Too short: expected at least ${minimum}` })
}
export const maxLength = <T extends WithLength>(maximum: number): Check<T> => (outcome) => {
  if (outcome.value.length > maximum) outcome.issues.push({ path: [], message: `Too long: expected at most ${maximum}` })
}
export const minimum = (bound: number): Check<number> => (outcome) => {
  if (outcome.value < bound) outcome.issues.push({ path: [], message: `Too small: expected at least ${bound}` })
}
export const maximum = (bound: number): Check<number> => (outcome) => {
  if (outcome.value > bound) outcome.issues.push({ path: [], message: `Too big: expected at most ${bound}` })
}
export const trim = (): Check<string> => (outcome) => {
  outcome.value = outcome.value.trim()
}
export const regex = (pattern: RegExp, message = 'Invalid format'): Check<string> => (outcome) => {
  pattern.lastIndex = 0
  if (!pattern.test(outcome.value)) outcome.issues.push({ path: [], message })
}
export const refine = <T>(accepts: (value: T) => boolean, options?: string | { message: string }): Check<T> => (outcome) => {
  if (outcome.issues.length === 0 && !accepts(outcome.value)) {
    const message = typeof options === 'string' ? options : options?.message ?? 'Invalid input'
    outcome.issues.push({ path: [], message })
  }
}
export const superRefine = <T>(validate: (value: T, context: RefinementContext) => void): Check<T> => (outcome) => {
  if (outcome.issues.length > 0) return
  validate(outcome.value, { addIssue: (issue) => outcome.issues.push(issue) })
}
