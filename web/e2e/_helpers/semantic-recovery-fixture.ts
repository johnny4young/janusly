export type SemanticFixtureLocale = 'en' | 'es'

export type SemanticRecoveryFixture = {
  orgId: string
  userId: string
  runId: string
  caseId: string
  workflowName: string
}

export function semanticFixtureCopy(locale: SemanticFixtureLocale) {
  return locale === 'en'
    ? {
        workflowName: 'Semantic outcome recovery',
        message: 'The draft requires an operator-approved business outcome.',
      }
    : {
        workflowName: 'Recuperación de resultado semántico',
        message: 'El borrador requiere un resultado de negocio aprobado por un operador.',
      }
}

function headers(orgId: string, userId: string) {
  return {
    'content-type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': userId,
  }
}

async function requestJson<T>(
  apiUrl: string,
  path: string,
  options: RequestInit & { orgId: string; userId: string },
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      ...headers(options.orgId, options.userId),
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status()}: ${text}`)
  }
  return JSON.parse(text) as T
}

/**
 * Creates a real semantic quarantine through the public runtime contract.
 * This helper cannot call an AI provider: the transform and detector are
 * deterministic, while the downstream HTTP effect remains paused.
 */
export async function createSemanticRecoveryFixture(
  locale: SemanticFixtureLocale,
  options: {
    apiUrl?: string
    autonomyLevel?: 0 | 1 | 2 | 3 | 4
    orgPrefix?: string
    orgSuffix?: string
  } = {},
): Promise<SemanticRecoveryFixture> {
  const apiUrl = options.apiUrl ?? process.env.E2E_API_URL ?? 'http://127.0.0.1:7311'
  const copy = semanticFixtureCopy(locale)
  const orgId = [
    options.orgPrefix ?? 'local-recovery-lab-semantic',
    locale,
    options.orgSuffix,
  ].filter(Boolean).join('-')
  const userId = `semantic-operator-${locale}`
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const target = `semantic-${locale}-${nonce}`
  const workflow = {
    dslVersion: '1.0',
    id: `semantic-outcome-${locale}-${nonce}`,
    name: copy.workflowName,
    nodes: [
      {
        id: 'draft_response',
        type: 'transform',
        config: {
          mapping: {
            mode: 'ai',
            approved: false,
            response: 'A syntactically valid draft that is not approved for delivery.',
          },
        },
      },
      {
        id: 'deliver',
        type: 'http',
        config: {
          url: `http://provider-simulator:4010/webhook?target=${target}`,
          method: 'POST',
          headers: { 'X-Idempotency-Key': target },
          body: { result: '{{context.draft_response.output.response}}' },
        },
      },
    ],
    edges: [{ from: 'draft_response', to: 'deliver' }],
    recovery: {
      contract: {
        version: '2',
        failure: {
          technical: {
            terminalNodeFailure: true,
            stalledNode: true,
          },
          semantic: {
            mode: 'deterministic',
            detectors: [
              {
                id: 'operator-approved',
                sourceNodeId: 'draft_response',
                kind: 'expression',
                passWhen: 'context.draft_response.output.approved === true',
                action: 'quarantine',
                message: copy.message,
                autonomyLevel: options.autonomyLevel ?? 3,
              },
            ],
            evaluationFixtures: [
              {
                id: 'approved-draft',
                sourceNodeId: 'draft_response',
                output: { mode: 'ai', approved: true, response: 'Reviewed draft' },
                expected: 'pass',
              },
              {
                id: 'unapproved-draft',
                sourceNodeId: 'draft_response',
                output: { mode: 'ai', approved: false, response: 'Unreviewed draft' },
                expected: 'violation',
              },
            ],
          },
        },
        evidence: {
          required: ['failure_snapshot', 'audit_trail', 'terminal_outcome'],
        },
        effects: [
          {
            nodeId: 'deliver',
            kind: 'notification',
            idempotency: 'required',
            receipt: 'provider',
          },
        ],
        repairs: { allowed: ['config_patch'] },
        validation: { minimumEvidenceLevel: 'static' },
        approval: {
          productionMutation: 'required',
          permission: 'recovery.write',
        },
        autonomyLevel: 3,
        verification: {
          kind: 'generation_bound_terminal_success',
        },
        recurrence: { windowDays: 7 },
      },
    },
  }

  const started = await requestJson<{ runId: string }>(apiUrl, '/start', {
    method: 'POST',
    orgId,
    userId,
    body: JSON.stringify({ workflow, input: {} }),
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await requestJson<{
      run: { status: string; outcomeStatus?: string | null }
      nodes: Array<{ nodeId: string; status: string }>
    }>(apiUrl, `/run?runId=${encodeURIComponent(started.runId)}`, {
      method: 'GET',
      orgId,
      userId,
    })
    const delivery = snapshot.nodes.find(node => node.nodeId === 'deliver')
    if (
      snapshot.run.status === 'waiting'
      && snapshot.run.outcomeStatus === 'semantic_quarantined'
      && delivery?.status === 'pending'
    ) {
      const listed = await requestJson<{
        cases: Array<{ id: string; action: string; state: string }>
      }>(apiUrl, `/recovery/cases?runId=${encodeURIComponent(started.runId)}`, {
        method: 'GET',
        orgId,
        userId,
      })
      const recoveryCase = listed.cases.find(
        item => item.action === 'quarantine' && item.state === 'contained',
      )
      if (!recoveryCase) throw new Error('semantic quarantine case was not persisted')
      return {
        orgId,
        userId,
        runId: started.runId,
        caseId: recoveryCase.id,
        workflowName: copy.workflowName,
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`run ${started.runId} did not enter semantic quarantine`)
}
