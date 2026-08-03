import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkflowGraphEdge, WorkflowGraphNode, WorkflowInputSchemaShape } from '../types'
import { useT } from '../i18n'
import {
  buildExpressionSuggestions,
  inspectExpressionAuthoring,
  type ExpressionSuggestion,
} from './expression-context'
import {
  defaultBranchRuleDraft,
  formatBranchRuleDraft,
  GUIDED_COMPARISON_OPERATORS,
  resolveBranchRuleAuthoring,
  type BranchRuleDraft,
  type BranchRuleMode,
  type GuidedComparisonOperator,
} from './branch-rule-model'

export function BranchRuleEditor({
  id,
  label,
  value,
  onChange,
  nodes,
  edges,
  targetNodeId,
  mode,
  workflowInputs,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  targetNodeId: string
  mode: 'node' | 'edge'
  workflowInputs?: WorkflowInputSchemaShape
}) {
  const { t } = useT()
  const allowUnconditional = mode === 'edge'
  const suggestions = useMemo(
    () => buildExpressionSuggestions({ nodes, edges, targetNodeId, mode, workflowInputs }),
    [edges, mode, nodes, targetNodeId, workflowInputs],
  )
  const sourceOptions = useMemo(() => {
    const options = suggestions.filter(isConcreteValueSuggestion)
    return options.length > 0
      ? options
      : [{ token: 'context.input.value' }]
  }, [suggestions])
  const preferredSourceId = mode === 'edge' ? targetNodeId : undefined
  const resolveAuthoring = (expression: string) => resolveBranchRuleAuthoring(
    expression,
    allowUnconditional,
    sourceOptions,
    preferredSourceId,
  )
  const [authoring, setAuthoring] = useState(() => resolveAuthoring(value))
  const { mode: selectedMode, draft } = authoring
  const editorMode = selectedMode === 'simple'
    && !sourceOptions.some(source => source.token === draft.left)
    ? 'advanced'
    : selectedMode
  const lastEmitted = useRef(value)

  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    setAuthoring(resolveAuthoring(value))
  }, [value])

  const emit = (expression: string) => {
    lastEmitted.current = expression
    onChange(expression)
  }

  const updateDraft = (patch: Partial<BranchRuleDraft>) => {
    const next = { ...draft, ...patch }
    setAuthoring({ mode: editorMode, draft: next })
    emit(formatBranchRuleDraft(next))
  }

  const modeId = `${id}-mode`
  const sourceId = `${id}-source`
  const operatorId = `${id}-operator`
  const valueId = `${id}-value`
  const authoringState = inspectExpressionAuthoring(value, suggestions, mode)
  const statusError = authoringState.status === 'invalid'
    ? authoringState.code === 'unresolved'
      ? t('expressionAssistant.unresolved', { references: authoringState.references?.join(', ') ?? '' })
      : t('expressionAssistant.invalidGrammar')
    : null
  const status = statusError ? (
    <div
      className="helper-text helper-text--error"
      role="alert"
    >
      {statusError}
    </div>
  ) : null

  return (
    <section className="quick-config">
      <div className="config-field-row">
        <label className="field-label" htmlFor={modeId}>{t('branchRule.mode')}</label>
        <select
          id={modeId}
          className="text-field"
          value={editorMode}
          onChange={(event) => {
            const nextMode = event.target.value as BranchRuleMode
            if (nextMode === 'always') {
              setAuthoring({ mode: nextMode, draft })
              emit(allowUnconditional ? '' : 'true')
              return
            }
            if (nextMode === 'simple') {
              const nextDraft = resolveAuthoring(value).draft
              setAuthoring({ mode: nextMode, draft: nextDraft })
              emit(formatBranchRuleDraft(nextDraft))
              return
            }
            setAuthoring({ mode: nextMode, draft })
          }}
        >
          <option value="always">{t('branchRule.mode.always')}</option>
          <option value="simple">{t('branchRule.mode.simple')}</option>
          <option value="advanced">{t('branchRule.mode.advanced')}</option>
        </select>
      </div>

      {editorMode === 'simple' && (
        <div className="we-branch-rule__simple">
          <div className="config-field-row">
            <label className="field-label" htmlFor={sourceId}>{t('branchRule.source')}</label>
            <select
              id={sourceId}
              className="text-field"
              value={draft.left}
              onChange={(event) => {
                const left = event.target.value
                const sourceDefault = defaultBranchRuleDraft([
                  sourceOptions.find(item => item.token === left)!,
                ])
                updateDraft({
                  left,
                  valueKind: sourceDefault.valueKind,
                  value: sourceDefault.value,
                })
              }}
            >
              {sourceOptions.map(suggestion => (
                <option
                  key={suggestion.token}
                  value={suggestion.token}
                >
                  {suggestion.token}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field-row">
            <label className="field-label" htmlFor={operatorId}>{t('branchRule.operator')}</label>
            <select
              id={operatorId}
              className="text-field"
              value={draft.operator}
              onChange={(event) => updateDraft({ operator: event.target.value as GuidedComparisonOperator })}
            >
              {(draft.valueKind === 'boolean'
                ? GUIDED_COMPARISON_OPERATORS.slice(0, 2)
                : GUIDED_COMPARISON_OPERATORS
              ).map(operator => (
                <option key={operator} value={operator}>
                  {t(`branchRule.operator.${operator}`, { defaultValue: operator })}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field-row">
            <label className="field-label" htmlFor={valueId}>{t('branchRule.value')}</label>
            {draft.valueKind === 'boolean' ? (
              <select
                id={valueId}
                className="text-field"
                value={draft.value}
                onChange={(event) => updateDraft({ value: event.target.value })}
              >
                <option value="true">{t('branchRule.value.true')}</option>
                <option value="false">{t('branchRule.value.false')}</option>
              </select>
            ) : (
              <input
                id={valueId}
                className="text-field"
                type={draft.valueKind === 'number' ? 'number' : 'text'}
                value={draft.value}
                aria-invalid={authoringState.status === 'invalid' || undefined}
                onChange={(event) => updateDraft({ value: event.target.value })}
              />
            )}
          </div>
          {status}
        </div>
      )}

      {editorMode === 'advanced' && (
        <div className="config-field-row">
          <label className="field-label" htmlFor={`${id}-advanced`}>{label}</label>
          <textarea
            id={`${id}-advanced`}
            className="code-field code-field-short"
            value={value}
            onChange={(event) => emit(event.target.value)}
            aria-invalid={authoringState.status === 'invalid' || undefined}
          />
          {status}
        </div>
      )}
    </section>
  )
}

function isConcreteValueSuggestion(suggestion: ExpressionSuggestion): boolean {
  return suggestion.valueType !== 'array'
    && suggestion.valueType !== 'unknown'
    && !suggestion.token.endsWith('.output')
}
