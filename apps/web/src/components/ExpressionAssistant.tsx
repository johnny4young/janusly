/** Graph-aware editor for the runtime's limited expression grammar. */

import { useMemo, useRef, useState } from 'react'
import { Braces, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react'
import { validateExpression } from '@janusly/shared/src/expression'
import type { WorkflowGraphEdge, WorkflowGraphNode, WorkflowInputSchemaShape } from '../types'
import { useT } from '../i18n'
import {
  buildExpressionSuggestions,
  findUnresolvedExpressionReferences,
  type ExpressionSuggestion,
  type ExpressionSuggestionKind,
} from './expression-context'

const suggestionKinds: ExpressionSuggestionKind[] = ['input', 'upstream', 'root', 'operator']

export function ExpressionAssistant({
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const suggestions = useMemo(
    () => buildExpressionSuggestions({ nodes, edges, targetNodeId, mode, workflowInputs }),
    [edges, mode, nodes, targetNodeId, workflowInputs],
  )
  const parserResult = value.trim() ? validateExpression(value) : null
  const edgeInputsError = mode === 'edge' && /\binputs(?:\.|\[)/.test(value.replace(/'[^']*'|"[^"]*"/g, ''))
  const unresolved = findUnresolvedExpressionReferences(value, suggestions, mode)
  const parserError = parserResult && !parserResult.valid
    ? parserResult.code === 'unsupported_token'
      ? t('expressionAssistant.unsupportedToken', { token: parserResult.token ?? '' })
      : parserResult.code === 'empty_value'
        ? t('expressionAssistant.emptyValue')
        : t('expressionAssistant.invalidGrammar')
    : null
  const error = parserError
    ? parserError
    : edgeInputsError
      ? t('expressionAssistant.edgeInputsUnsupported')
      : unresolved.length > 0
        ? t('expressionAssistant.unresolved', { references: unresolved.join(', ') })
      : null
  const statusId = `${id}-expression-status`

  const insertToken = ({ token, caretOffset }: ExpressionSuggestion) => {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? value.length
    const end = textarea?.selectionEnd ?? start
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`
    onChange(next)
    window.requestAnimationFrame(() => {
      const caret = start + (caretOffset ?? token.length)
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className="config-field-row we-expression-assistant" data-testid="expression-assistant">
      <div className="split-row we-expression-assistant__header">
        <label className="field-label" htmlFor={id}>{label}</label>
        <button
          type="button"
          className="small-command"
          aria-expanded={expanded}
          aria-controls={`${id}-expression-options`}
          onClick={() => setExpanded((current) => !current)}
        >
          <Braces size={13} aria-hidden="true" />
          {t('expressionAssistant.context')}
          {expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        </button>
      </div>
      <textarea
        ref={textareaRef}
        id={id}
        className="code-field code-field-short"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={statusId}
      />
      <div
        id={statusId}
        className={error ? 'we-expression-assistant__status we-expression-assistant__status--error' : 'we-expression-assistant__status'}
        role={error ? 'alert' : 'status'}
      >
        {error ? (
          <span>{t('expressionAssistant.invalid', { detail: error })}</span>
        ) : value.trim() ? (
          <><CheckCircle2 size={13} aria-hidden="true" /><span>{t('expressionAssistant.valid')}</span></>
        ) : (
          <span>{t('expressionAssistant.empty')}</span>
        )}
      </div>

      {expanded && (
        <div id={`${id}-expression-options`} className="we-expression-assistant__options">
          <p className="helper-text">{t('expressionAssistant.helper')}</p>
          {suggestionKinds.map((kind) => {
            const group = suggestions.filter((suggestion) => suggestion.kind === kind)
            if (group.length === 0) return null
            return (
              <section key={kind} className="we-expression-assistant__group">
                <strong>{t(`expressionAssistant.group.${kind}`)}</strong>
                <div className="we-expression-assistant__tokens">
                  {group.map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion.id}
                      className="we-expression-assistant__token"
                      onClick={() => insertToken(suggestion)}
                      title={t('expressionAssistant.insert', { token: suggestion.token })}
                      aria-label={t('expressionAssistant.insert', { token: suggestion.token })}
                    >
                      <code>{suggestion.token}</code>
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
