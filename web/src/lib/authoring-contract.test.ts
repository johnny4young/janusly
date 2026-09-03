import { describe, expect, it } from 'vitest'

import type { WorkflowBriefCompilation, WorkflowProposalResponse } from '../types'
import {
  isWorkflowBriefCompilation,
  isWorkflowProposalApplySafe,
  isWorkflowProposalResponse,
  parseWorkflowVersionSnapshot,
} from './authoring-contract'

const brief: WorkflowBriefCompilation['brief'] = {
  version: '1',
  objective: 'Handle the matching incident',
  trigger: 'pagerduty',
  inputs: [],
  expectedOutcome: 'The provider state is verified',
  externalEffects: ['pagerduty_acknowledge', 'pagerduty_snooze'],
  approvals: [],
  failurePolicy: 'stop_and_open_recovery_case',
  examples: [],
  language: 'en',
}

function validProposal(): WorkflowProposalResponse {
  return {
    mode: 'fallback',
    brief,
    clarifyingQuestions: [],
    bindings: { catalogVersion: 'catalog-v1', resolved: [], missing: [], complete: true },
    proposal: {
      workflow: {
        dslVersion: '1.0',
        id: 'pagerduty-example',
        inputs: {
          type: 'object',
          properties: {
            timeZone: { type: 'string', description: 'IANA timezone', default: 'America/Bogota' },
          },
        },
        outputs: { result: '{{context.done.output}}' },
        nodes: [{ id: 'done', type: 'noop', config: {} }],
        edges: [],
      },
      intentContract: { result: '{{context.done.output}}' },
      recoveryContract: null,
      qualification: { intent: true, recovery: false, semantic: false },
      assumptions: ['deterministic_template'],
      risks: [],
      readiness: { status: 'pass', issues: [] },
      diff: { nodesAdded: ['done'], nodesRemoved: [], nodesChanged: [], edgesBefore: 0, edgesAfter: 0 },
      applicable: true,
    },
  }
}

describe('authoring contract runtime guards', () => {
  it('binds an exact immutable workflow snapshot to both requested ids', () => {
    const dagJson = validProposal().proposal.workflow
    const snapshot = {
      id: 'version-2',
      workflowId: 'pagerduty-example',
      version: 2,
      dagJson,
    }
    expect(parseWorkflowVersionSnapshot(snapshot, 'pagerduty-example', 'version-2')).toEqual(snapshot)
    expect(parseWorkflowVersionSnapshot({ ...snapshot, id: 'version-swapped' }, 'pagerduty-example', 'version-2')).toBeNull()
    expect(parseWorkflowVersionSnapshot({ ...snapshot, workflowId: 'other' }, 'pagerduty-example', 'version-2')).toBeNull()
    expect(parseWorkflowVersionSnapshot({ ...snapshot, version: 0 }, 'pagerduty-example', 'version-2')).toBeNull()
    expect(parseWorkflowVersionSnapshot({ ...snapshot, extra: true }, 'pagerduty-example', 'version-2')).toBeNull()
    expect(parseWorkflowVersionSnapshot({
      ...snapshot,
      dagJson: { ...dagJson, id: 'other' },
    }, 'pagerduty-example', 'version-2')).toBeNull()
  })

  it('accepts the complete deterministic brief envelope', () => {
    expect(isWorkflowBriefCompilation({
      brief,
      clarifyingQuestions: [],
      complete: true,
      mode: 'deterministic',
    })).toBe(true)
  })

  it('rejects a stale or malformed brief envelope', () => {
    expect(isWorkflowBriefCompilation({ brief: { ...brief, language: 'fr' }, clarifyingQuestions: [], complete: true, mode: 'deterministic' })).toBe(false)
    expect(isWorkflowBriefCompilation({ brief, clarifyingQuestions: null, complete: true, mode: 'deterministic' })).toBe(false)
  })

  it('accepts a complete proposal before Apply', () => {
    expect(isWorkflowProposalResponse(validProposal())).toBe(true)
  })

  it('accepts a non-empty optional edge id and rejects an empty one', () => {
    const valid = validProposal()
    const edge = { id: 'qualified-route', from: 'done', to: 'done' }
    expect(isWorkflowProposalResponse({
      ...valid,
      proposal: {
        ...valid.proposal,
        workflow: { ...valid.proposal.workflow, edges: [edge] },
      },
    })).toBe(true)
    expect(isWorkflowProposalResponse({
      ...valid,
      proposal: {
        ...valid.proposal,
        workflow: { ...valid.proposal.workflow, edges: [{ ...edge, id: ' ' }] },
      },
    })).toBe(false)
  })

  it('accepts explicit empty binding arrays and rejects null wire collections', () => {
    const valid = validProposal()
    const incomplete = {
      ...valid,
      bindings: {
        ...valid.bindings,
        complete: false,
        missing: [{
          kind: 'credential',
          nodeId: 'acknowledge',
          field: 'credential',
          requested: 'pagerduty-api',
          alternatives: [],
          reason: 'exact_credential_not_found',
        }],
      },
      proposal: { ...valid.proposal, applicable: false },
    }
    expect(isWorkflowProposalResponse(incomplete)).toBe(true)
    expect(isWorkflowProposalResponse({
      ...incomplete,
      bindings: {
        ...incomplete.bindings,
        missing: [{ ...incomplete.bindings.missing[0], alternatives: null }],
      },
    })).toBe(false)
  })

  it('rejects missing governed fields and malformed executable graph shapes', () => {
    const valid = validProposal()
    const { recoveryContract: _omitted, ...withoutRecoveryContract } = valid.proposal
    expect(isWorkflowProposalResponse({ ...valid, proposal: withoutRecoveryContract })).toBe(false)
    expect(isWorkflowProposalResponse({
      ...valid,
      proposal: {
        ...valid.proposal,
        workflow: { ...valid.proposal.workflow, nodes: [{ id: 'unsafe', type: 'tool', config: 'not-an-object' }] },
      },
    })).toBe(false)
    expect(isWorkflowProposalResponse({
      ...valid,
      proposal: { ...valid.proposal, intentContract: { result: 42 } },
    })).toBe(false)
    expect(isWorkflowProposalResponse({
      ...valid,
      proposal: {
        ...valid.proposal,
        workflow: { ...valid.proposal.workflow, nodes: [{ id: ' ', type: 'noop', config: {} }] },
      },
    })).toBe(false)
  })

  it('rejects malformed or excessive nested input schema projections', () => {
    const valid = validProposal()
    expect(isWorkflowProposalResponse({
      ...valid,
      proposal: {
        ...valid.proposal,
        workflow: { ...valid.proposal.workflow, inputs: { type: 'object', properties: { bad: { type: 'secret' } } } },
      },
    })).toBe(false)

    const properties = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [
      `field_${index}`,
      { type: 'string' },
    ]))
    expect(isWorkflowProposalResponse({
      ...valid,
      proposal: {
        ...valid.proposal,
        workflow: { ...valid.proposal.workflow, inputs: { type: 'object', properties } },
      },
    })).toBe(false)
  })

  it('rejects non-canonical workflow carriers before they can reach Apply', () => {
    const valid = validProposal()
    const malformedWorkflows = [
      { ...valid.proposal.workflow, providerOnly: true },
      { ...valid.proposal.workflow, metadata: { description: '  not canonical  ', owner: 'provider' } },
      { ...valid.proposal.workflow, ui: { positions: { done: { x: Number.NaN, y: 0 } } } },
      { ...valid.proposal.workflow, recovery: null },
      { ...valid.proposal.workflow, nodes: [{ id: 'done', type: 'noop', config: {}, providerOnly: true }] },
      { ...valid.proposal.workflow, nodes: [{ id: 'done', type: 'noop', config: {} }, { id: 'done', type: 'noop', config: {} }] },
      { ...valid.proposal.workflow, edges: [{ from: 'done', to: 'missing' }] },
    ]
    for (const workflow of malformedWorkflows) {
      expect(isWorkflowProposalResponse({
        ...valid,
        proposal: { ...valid.proposal, workflow },
      })).toBe(false)
    }
  })

  it('enforces the bounded clarification and numeric proposal envelope', () => {
    const valid = validProposal()
    expect(isWorkflowProposalResponse({ ...valid, clarifyingQuestions: ['1', '2', '3', '4'] })).toBe(false)
    expect(isWorkflowProposalResponse({ ...valid, bonBackoff: { from: 1.5, to: 2 } })).toBe(false)
    expect(isWorkflowProposalResponse({
      ...valid,
      proposal: { ...valid.proposal, diff: { ...valid.proposal.diff, edgesAfter: -1 } },
    })).toBe(false)
  })

  it('binds displayed contracts and qualification to the exact applied workflow', async () => {
    const valid = validProposal()
    expect(await isWorkflowProposalApplySafe(valid)).toBe(true)
    expect(await isWorkflowProposalApplySafe({
      ...valid,
      proposal: { ...valid.proposal, intentContract: { result: '{{context.other.output}}' } },
    })).toBe(false)
    expect(await isWorkflowProposalApplySafe({
      ...valid,
      proposal: { ...valid.proposal, recoveryContract: { version: '2' } },
    })).toBe(false)
    expect(await isWorkflowProposalApplySafe({
      ...valid,
      proposal: {
        ...valid.proposal,
        qualification: { ...valid.proposal.qualification, intent: false },
      },
    })).toBe(false)
  })

  it('loads the strict recovery validator only at the final Apply boundary', async () => {
    const valid = validProposal()
    const invalidRecovery = {
      ...valid,
      proposal: {
        ...valid.proposal,
        workflow: { ...valid.proposal.workflow, recovery: { circuitBreaker: 1 } },
      },
    }
    expect(isWorkflowProposalResponse(invalidRecovery)).toBe(false)

    const strictOnlyInvalid = {
      ...valid,
      proposal: {
        ...valid.proposal,
        workflow: { ...valid.proposal.workflow, recovery: { contract: { version: '2' } } },
        recoveryContract: { version: '2' },
        qualification: { ...valid.proposal.qualification, recovery: true, semantic: true },
      },
    }
    expect(isWorkflowProposalResponse(strictOnlyInvalid)).toBe(true)
    expect(await isWorkflowProposalApplySafe(strictOnlyInvalid)).toBe(false)
  })
})
