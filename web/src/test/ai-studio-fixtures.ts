import type { AuthoringCapabilityCatalog, WorkflowBriefCompilation, WorkflowDefinition, WorkflowProposalResponse } from '../types'

export const catalog: AuthoringCapabilityCatalog = {
  schemaVersion: '1',
  version: 'catalog-v1',
  builtinTools: [{
    name: 'http.request',
    description: 'Bounded HTTP request',
    inputFields: [],
    required: ['url'],
    optional: [],
    writeSide: false,
  }],
  mcpTools: [],
  triggers: [{ id: 'manual', requiredConfig: [] }],
  credentials: [],
  subworkflows: [],
  primitives: [{ nodeType: 'transform', notes: 'Local transform', requiredConfig: [] }],
  warnings: [],
}

export const compilation: WorkflowBriefCompilation = {
  mode: 'deterministic',
  complete: true,
  clarifyingQuestions: [],
  brief: {
    version: '1',
    objective: 'Route high-risk refunds for approval',
    trigger: 'manual',
    inputs: ['refund'],
    expectedOutcome: 'An approved refund decision',
    externalEffects: ['refund'],
    approvals: ['finance'],
    failurePolicy: 'stop and notify',
    examples: ['refund 42'],
    language: 'en',
  },
}

export function workflowProposal(overrides: Partial<WorkflowProposalResponse> = {}): WorkflowProposalResponse {
  return {
    mode: 'ai',
    brief: compilation.brief,
    clarifyingQuestions: [],
    bindings: {
      catalogVersion: catalog.version,
      resolved: [{
        kind: 'tool',
        nodeId: 'check',
        field: 'tool',
        requested: 'http.request',
        resolvedId: 'http.request',
        alternatives: [],
      }],
      missing: [],
      complete: true,
    },
    proposal: {
      workflow: {
        dslVersion: '1.0',
        id: 'wf_proposed',
        name: 'Refund assurance',
        nodes: [{ id: 'check', type: 'tool', config: { tool: 'http.request' } }],
        edges: [],
        outputs: { result: '{{context.check.output}}' },
        recovery: {
          circuitBreaker: 3,
          contract: {
            version: '2',
            failure: {
              technical: { terminalNodeFailure: true, stalledNode: true },
              semantic: { mode: 'deterministic', detectors: [], evaluationFixtures: [] },
            },
          },
        },
      } as unknown as WorkflowDefinition,
      intentContract: { result: '{{context.check.output}}' },
      recoveryContract: { version: '2' },
      qualification: { intent: true, recovery: true, semantic: true },
      assumptions: ['manual_trigger'],
      risks: [],
      readiness: { status: 'pass', issues: [] },
      diff: {
        nodesAdded: ['check'],
        nodesRemoved: [],
        nodesChanged: [],
        edgesBefore: 0,
        edgesAfter: 0,
      },
      applicable: true,
    },
    ...overrides,
  }
}

