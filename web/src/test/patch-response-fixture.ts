type Row = Record<string, unknown>

function canonical(workflow: unknown): Row {
  return { dslVersion: '1.0', ...workflow as Row }
}

function tab(value: Row, confidence: number): Row {
  return {
    approachLabel: 'other', confidence, calibratedConfidence: value.confidence ?? confidence,
    safety: { writeSide: false, approvalRequired: false, approvalPresent: false }, consideredAlternatives: [],
    ...value, workflow: canonical(value.workflow),
  }
}

/**
 * A manifest-complete `POST /ai/patch-workflow` payload. A fixture without
 * `suggestions` gets one tab built from `suggestedWorkflow` and `rationale`.
 */
export function patchResponse(value: Row, failureSignature = 'Network timeout on http node'): Row {
  const confidence = value.mode === 'ai' ? 50 : 0
  const suggestedWorkflow = canonical(value.suggestedWorkflow ?? (value.suggestions as Row[] | undefined)?.[0]?.workflow)
  const suggestions = (value.suggestions as Row[] | undefined)
    ?? [{ workflow: suggestedWorkflow, rationale: value.rationale }]
  return {
    evidence: [],
    recoveryPassport: { failureSignature, priorSameSignatureOutcome: null },
    rationale: '',
    ...value,
    suggestedWorkflow,
    suggestions: suggestions.map(item => tab(item, confidence)),
  }
}
