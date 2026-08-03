/**
 * Runtime-neutral lifecycle contract for observing workflows executed outside
 * Janusly. The envelope follows the required CloudEvents 1.0 JSON fields while
 * the data union stays deliberately small enough to validate and project
 * deterministically.
 *
 * This contract is observation-only. It contains no retry, resume, cancel, or
 * replay command and therefore cannot be mistaken for mutation authority over
 * the source runtime.
 */

import { z } from 'zod'

export const EXTERNAL_RUNTIME_EVENT_TYPES = [
  'io.janusly.external.workflow.observed',
  'io.janusly.external.run.observed',
  'io.janusly.external.step.observed',
] as const

export const EXTERNAL_RUNTIME_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
] as const

export const EXTERNAL_EVIDENCE_KINDS = [
  'url',
  'trace',
  'log',
  'artifact',
] as const

export type ExternalRuntimeEventType = (typeof EXTERNAL_RUNTIME_EVENT_TYPES)[number]
export type ExternalRuntimeStatus = (typeof EXTERNAL_RUNTIME_STATUSES)[number]
export type ExternalEvidenceKind = (typeof EXTERNAL_EVIDENCE_KINDS)[number]

const IdSchema = z.string().trim().min(1).max(256)
const LabelSchema = z.string().trim().min(1).max(200)
const OptionalTimestampSchema = z.iso.datetime({ offset: true }).optional()

export const ExternalEvidencePointerSchema = z.object({
  kind: z.enum(EXTERNAL_EVIDENCE_KINDS),
  label: LabelSchema,
  locator: z.string().trim().min(1).max(2_048),
}).strict()

const ObservationBaseSchema = z.object({
  sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  snapshot: z.unknown().optional(),
  evidence: z.array(ExternalEvidencePointerSchema).max(20).default([]),
}).strict()

export const ExternalWorkflowObservationSchema = ObservationBaseSchema.extend({
  externalWorkflowId: IdSchema,
  name: LabelSchema,
  version: z.string().trim().min(1).max(200).optional(),
}).strict()

export const ExternalRunObservationSchema = ObservationBaseSchema.extend({
  externalWorkflowId: IdSchema,
  externalRunId: IdSchema,
  status: z.enum(EXTERNAL_RUNTIME_STATUSES),
  startedAt: OptionalTimestampSchema,
  completedAt: OptionalTimestampSchema,
}).strict()

export const ExternalStepObservationSchema = ObservationBaseSchema.extend({
  externalWorkflowId: IdSchema,
  externalRunId: IdSchema,
  externalStepId: IdSchema,
  name: LabelSchema,
  status: z.enum(EXTERNAL_RUNTIME_STATUSES),
  attempt: z.int().min(1).max(10_000).default(1),
  startedAt: OptionalTimestampSchema,
  completedAt: OptionalTimestampSchema,
}).strict()

const CloudEventBaseSchema = z.object({
  specversion: z.literal('1.0'),
  id: IdSchema,
  source: z.string().trim().min(1).max(512),
  subject: z.string().trim().min(1).max(512).optional(),
  time: z.iso.datetime({ offset: true }),
  datacontenttype: z.literal('application/json').optional(),
}).strict()

export const ExternalWorkflowEventSchema = CloudEventBaseSchema.extend({
  type: z.literal(EXTERNAL_RUNTIME_EVENT_TYPES[0]),
  data: ExternalWorkflowObservationSchema,
}).strict()

export const ExternalRunEventSchema = CloudEventBaseSchema.extend({
  type: z.literal(EXTERNAL_RUNTIME_EVENT_TYPES[1]),
  data: ExternalRunObservationSchema,
}).strict()

export const ExternalStepEventSchema = CloudEventBaseSchema.extend({
  type: z.literal(EXTERNAL_RUNTIME_EVENT_TYPES[2]),
  data: ExternalStepObservationSchema,
}).strict()

export const ExternalRuntimeEventSchema = z.discriminatedUnion('type', [
  ExternalWorkflowEventSchema,
  ExternalRunEventSchema,
  ExternalStepEventSchema,
])

export type ExternalEvidencePointer = z.infer<typeof ExternalEvidencePointerSchema>
export type ExternalWorkflowObservation = z.infer<typeof ExternalWorkflowObservationSchema>
export type ExternalRunObservation = z.infer<typeof ExternalRunObservationSchema>
export type ExternalStepObservation = z.infer<typeof ExternalStepObservationSchema>
export type ExternalWorkflowEvent = z.infer<typeof ExternalWorkflowEventSchema>
export type ExternalRunEvent = z.infer<typeof ExternalRunEventSchema>
export type ExternalStepEvent = z.infer<typeof ExternalStepEventSchema>
export type ExternalRuntimeEvent = z.infer<typeof ExternalRuntimeEventSchema>

export function parseExternalRuntimeEvent(value: unknown): ExternalRuntimeEvent {
  return ExternalRuntimeEventSchema.parse(value)
}
