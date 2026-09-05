import { AlertTriangle, CheckCircle2, Sparkles, Workflow } from 'lucide-react'
import { formatAiModeLabel } from '../../constants'
import { useT } from '../../i18n'
import { Button } from '../ui/Button'
import { FormActions, FormDisclosure, FormField, TextInput } from '../ui/Form'
import { StatusSummary } from '../ui/StatusSummary'
import { CostEstimateChip } from './CostEstimateChip'
import {
  CATALOG_WARNING_COPY,
  MAX_AUTHORING_PROMPT_CHARS,
  MAX_CLARIFICATION_ANSWER_CHARS,
  MAX_PROPOSAL_INPUT_DEFAULTS,
  SIGNAL_COPY_KEYS,
  describeAiError,
  formatAuthoringDuration,
  formatWorkflowInputDefault,
  totalCatalogCapabilities,
} from './model'
import type { AiStudioModel } from './useAiStudioController'

// The four authoring stages — intent, capability binding, proposal, apply —
// plus the authoring error banner that follows them.
export function AuthoringStages({ model }: { model: AiStudioModel }) {
  const { t } = useT()
  const {
    health,
    prompt,
    promptRef,
    replacePrompt,
    starterPrompts,
    authoringLoading,
    compileBrief,
    briefCompilation,
    clarificationAnswers,
    answerClarification,
    catalog,
    catalogLoading,
    catalogError,
    proposal,
    buildProposal,
    briefCompileMs,
    proposalBuildMs,
    applied,
    applyProposal,
    authoringError,
  } = model
  const bindingComplete = Boolean(proposal?.bindings.complete)
  const proposalCatalogCurrent = Boolean(
    proposal && catalog && proposal.bindings.catalogVersion === catalog.version,
  )
  const proposalApplicable = Boolean(
    proposal?.proposal.applicable && bindingComplete && proposalCatalogCurrent,
  )
  const writeToolNames = new Set(catalog?.builtinTools.filter((tool) => tool.writeSide).map((tool) => tool.name) ?? [])
  const writeMcpToolNames = new Set(catalog?.mcpTools.filter((tool) => tool.writeSide).map((tool) => (
    `${tool.connectionAlias}\u0000${tool.toolName}`
  )) ?? [])
  const externalWriteCount = proposal?.proposal.workflow.nodes.filter((node) => (
    (node.type === 'tool' && writeToolNames.has(String(node.config.tool ?? '')))
    || (node.type === 'mcp_tool' && writeMcpToolNames.has(
      `${String(node.config.connectionAlias ?? '')}\u0000${String(node.config.toolName ?? '')}`,
    ))
    || (node.type === 'http' && !['GET', 'HEAD', 'OPTIONS'].includes(
      String(node.config.method ?? 'GET').toUpperCase(),
    ))
  )).length ?? 0
  const assuranceLayerCount = proposal
    ? Object.values(proposal.proposal.qualification).filter(Boolean).length
    : 0
  const allConfiguredInputDefaults = Object.entries(
    proposal?.proposal.workflow.inputs?.properties ?? {},
  ).flatMap(([name, schema]) => (
    Object.prototype.hasOwnProperty.call(schema, 'default')
      ? [{
          name,
          description: schema.description ?? '',
          value: formatWorkflowInputDefault(schema.default),
        }]
      : []
  ))
  const configuredInputDefaults = allConfiguredInputDefaults.slice(0, MAX_PROPOSAL_INPUT_DEFAULTS)
  const authoringElapsedMs = briefCompileMs === null || proposalBuildMs === null
    ? null
    : briefCompileMs + proposalBuildMs
  const zeroCallLocalProposal = Boolean(
    proposal?.mode === 'fallback' && !proposal.aiError && !proposal.providerGuarded,
  )
  return (
    <>
      <section className="we-card ai-authoring-stage">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.steps.intent')}</div>
            <strong>{t('aiStudio.tellHeading')}</strong>
          </div>
          <span className="mode-pill mode-pill-neutral">{t('aiStudio.brief.localCompiler')}</span>
        </div>

        <FormField
          id="ai-authoring-intent"
          label={t('aiStudio.brief.promptLabel')}
          hint={t('aiStudio.brief.promptHint')}
          required
        >
          {(controlProps) => (
            <textarea
              {...controlProps}
              ref={promptRef}
              className="ai-studio-prompt"
              value={prompt}
              maxLength={MAX_AUTHORING_PROMPT_CHARS}
              disabled={authoringLoading !== null}
              onChange={(event) => { replacePrompt(event.target.value) }}
              placeholder={t('aiStudio.placeholder')}
            />
          )}
        </FormField>

        <div className="suggestion-row" aria-label={t('aiStudio.examplesAria')}>
          {starterPrompts.map((starter) => (
            <Button
              key={starter}
              size="sm"
              variant="ghost"
              disabled={authoringLoading !== null}
              onClick={() => { replacePrompt(starter) }}
            >
              {starter.slice(0, 34)}…
            </Button>
          ))}
        </div>

        <FormActions>
          <Button
            variant="primary"
            leadingIcon={<Sparkles size={16} />}
            loading={authoringLoading === 'compile'}
            loadingLabel={t('aiStudio.brief.compiling')}
            disabled={!prompt.trim() || authoringLoading !== null}
            onClick={() => { void compileBrief() }}
          >
            {t('aiStudio.brief.compile')}
          </Button>
        </FormActions>

        {briefCompilation && (
          <div className="ai-brief-summary" data-testid="intent-brief">
            <dl>
              <div><dt>{t('aiStudio.brief.objective')}</dt><dd>{briefCompilation.brief.objective}</dd></div>
              <div><dt>{t('aiStudio.brief.trigger')}</dt><dd>{briefCompilation.brief.trigger}</dd></div>
              <div><dt>{t('aiStudio.brief.outcome')}</dt><dd>{briefCompilation.brief.expectedOutcome}</dd></div>
              <div><dt>{t('aiStudio.brief.failurePolicy')}</dt><dd>{briefCompilation.brief.failurePolicy}</dd></div>
            </dl>
            {briefCompilation.clarifyingQuestions.length > 0 && (
              <StatusSummary
                tone="info"
                title={t('aiStudio.brief.questions')}
                description={(
                  <ol className="ai-brief-questions">
                    {briefCompilation.clarifyingQuestions.slice(0, 3).map((question, index) => (
                      <li key={question}>
                        <span>{question}</span>
                        <TextInput
                          aria-label={question}
                          value={clarificationAnswers[index] ?? ''}
                          maxLength={MAX_CLARIFICATION_ANSWER_CHARS}
                          disabled={authoringLoading !== null}
                          placeholder={t('aiStudio.brief.answerPlaceholder')}
                          onChange={(event) => { answerClarification(index, event.target.value) }}
                        />
                      </li>
                    ))}
                  </ol>
                )}
                actions={(
                  <Button
                    loading={authoringLoading === 'compile'}
                    disabled={
                      !briefCompilation.clarifyingQuestions.some((_, index) => (
                        Boolean(clarificationAnswers[index]?.trim())
                      )) || authoringLoading !== null
                    }
                    onClick={() => { void compileBrief() }}
                  >
                    {t('aiStudio.brief.recompile')}
                  </Button>
                )}
              />
            )}
            <FormDisclosure summary={t('aiStudio.brief.details')}>
              <dl>
                <div><dt>{t('aiStudio.brief.inputs')}</dt><dd>{briefCompilation.brief.inputs.join(', ') || t('common.none')}</dd></div>
                <div><dt>{t('aiStudio.brief.effects')}</dt><dd>{briefCompilation.brief.externalEffects.join(', ') || t('common.none')}</dd></div>
                <div><dt>{t('aiStudio.brief.approvals')}</dt><dd>{briefCompilation.brief.approvals.join(', ') || t('common.none')}</dd></div>
                <div><dt>{t('aiStudio.brief.examples')}</dt><dd>{briefCompilation.brief.examples.join(', ') || t('common.none')}</dd></div>
              </dl>
            </FormDisclosure>
          </div>
        )}
      </section>

      <section className="we-card ai-authoring-stage">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.steps.binding')}</div>
            <strong>{t('aiStudio.binding.heading')}</strong>
          </div>
          {catalog && (
            <span className="mode-pill mode-pill-neutral">
              {t('aiStudio.catalog.count', { count: totalCatalogCapabilities(catalog) })}
            </span>
          )}
        </div>

        {catalogLoading && <StatusSummary title={t('aiStudio.catalog.loading')} />}
        {catalogError && (
          <StatusSummary
            role="alert"
            tone="danger"
            title={t('aiStudio.catalog.loadFailed')}
            description={catalogError}
          />
        )}
        {catalog && (
          <>
            <dl className="ai-catalog-summary" data-testid="capability-catalog-summary">
              <div><dt>{t('aiStudio.catalog.tools')}</dt><dd>{catalog.builtinTools.length}</dd></div>
              <div><dt>{t('aiStudio.catalog.mcp')}</dt><dd>{catalog.mcpTools.length}</dd></div>
              <div><dt>{t('aiStudio.catalog.credentials')}</dt><dd>{catalog.credentials.length}</dd></div>
              <div><dt>{t('aiStudio.catalog.workflows')}</dt><dd>{catalog.subworkflows.length}</dd></div>
            </dl>
            {catalog.warnings.length > 0 && (
              <StatusSummary
                tone="warning"
                icon={<AlertTriangle size={16} />}
                title={t('aiStudio.catalog.degraded')}
                description={catalog.warnings.map((warning) => {
                  const copy = CATALOG_WARNING_COPY[warning]
                  return copy
                    ? `${t(copy[0])}: ${t(copy[1])}`
                    : warning
                }).join(' · ')}
              />
            )}
          </>
        )}

        {proposal && (
          <div className="ai-binding-report" data-testid="capability-binding-report">
            <StatusSummary
              tone={proposal.bindings.complete ? 'success' : 'warning'}
              title={proposal.bindings.complete ? t('aiStudio.binding.complete') : t('aiStudio.binding.incomplete')}
              description={t('aiStudio.binding.summary', {
                resolved: proposal.bindings.resolved.length,
                missing: proposal.bindings.missing.length,
              })}
            />
            {proposal.bindings.resolved.length > 0 && (
              <FormDisclosure summary={t('aiStudio.binding.resolved')}>
                <ul>
                  {proposal.bindings.resolved.map((binding, index) => (
                    <li key={[binding.nodeId, binding.field, index].join('-')}>
                      <strong>{binding.nodeId}</strong>
                      <span>{binding.resolvedId ?? binding.requested}</span>
                    </li>
                  ))}
                </ul>
              </FormDisclosure>
            )}
            {proposal.bindings.missing.map((binding, index) => (
              <article className="ai-binding-missing" key={[binding.nodeId, binding.field, index].join('-')}>
                <strong>
                  {t('aiStudio.binding.missingAt', { node: binding.nodeId || t('common.unknown'), field: binding.field })}
                </strong>
                <span>{binding.requested ?? binding.reason ?? t('common.unknown')}</span>
                {binding.alternatives.length > 0 && (
                  <>
                    <small>{t('aiStudio.binding.alternatives', { alternatives: binding.alternatives.join(', ') })}</small>
                    <small>{t('aiStudio.brief.questions')}</small>
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="we-card ai-authoring-stage">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.steps.proposal')}</div>
            <strong>{t('aiStudio.proposal.heading')}</strong>
          </div>
          {proposal && (
            <span className={'mode-pill mode-pill-' + proposal.mode}>
              {formatAiModeLabel(proposal.mode)}
            </span>
          )}
        </div>

        <p className="helper-text">{t('aiStudio.proposal.body')}</p>
        <FormActions>
          <Button
            variant="primary"
            leadingIcon={<Workflow size={16} />}
            loading={authoringLoading === 'propose'}
            loadingLabel={t('aiStudio.proposal.building')}
            disabled={!briefCompilation?.complete || !catalog || authoringLoading !== null}
            onClick={() => { void buildProposal() }}
            trailingIcon={<CostEstimateChip action="proposal" model={health?.model} />}
          >
            {t('aiStudio.proposal.build')}
          </Button>
        </FormActions>

        {proposal && (
          <div className="ai-proposal" data-testid="workflow-proposal">
            {proposal.providerGuarded ? (
              <div data-testid="provider-output-guarded">
                <StatusSummary
                  role="status"
                  tone="warning"
                  title={t('aiStudio.proposal.guardedTitle')}
                  description={t('aiStudio.proposal.guardedBody')}
                />
              </div>
            ) : proposal.mode === 'fallback' && (
              <StatusSummary
                role="status"
                tone="info"
                title={t('aiStudio.proposal.localTitle')}
                description={t('aiStudio.proposal.localBody')}
              />
            )}
            {proposal.aiError && (
              <StatusSummary
                role="status"
                tone="warning"
                title={t('aiStudio.aiFailedTitle')}
                description={describeAiError(t, proposal.aiError)}
              />
            )}
            {proposal.bonBackoff && (
              <div data-testid="ai-candidate-backoff">
                <StatusSummary
                  role="status"
                  tone="warning"
                  title={t('aiStudio.backoff.title')}
                  description={t('aiStudio.backoff.body', proposal.bonBackoff)}
                />
              </div>
            )}
            <dl className="ai-proposal-facts">
              <div><dt>{t('aiStudio.proposal.readiness')}</dt><dd>{proposal.proposal.readiness.status}</dd></div>
              <div><dt>{t('aiStudio.proposal.nodes')}</dt><dd>{proposal.proposal.workflow.nodes.length}</dd></div>
              <div><dt>{t('aiStudio.proposal.edges')}</dt><dd>{proposal.proposal.workflow.edges.length}</dd></div>
              <div>
                <dt>{t('aiStudio.proposal.diff')}</dt>
                <dd>{t('aiStudio.proposal.diffValue', {
                  added: proposal.proposal.diff.nodesAdded.length,
                  changed: proposal.proposal.diff.nodesChanged.length,
                  removed: proposal.proposal.diff.nodesRemoved.length,
                })}</dd>
              </div>
            </dl>

            {configuredInputDefaults.length > 0 && (
              <FormDisclosure
                className="ai-proposal-inputs"
                summary={`${t('aiStudio.brief.inputs')} (${allConfiguredInputDefaults.length})`}
              >
                <p className="helper-text">{t('aiStudio.apply.body')}</p>
                <dl className="ai-proposal-facts">
                  {configuredInputDefaults.map(input => (
                    <div key={input.name}>
                      <dt>{input.name}</dt>
                      <dd>{input.value}</dd>
                      {input.description && <small>{input.description}</small>}
                    </div>
                  ))}
                </dl>
                {allConfiguredInputDefaults.length > configuredInputDefaults.length && (
                  <small>
                    {t('dlq.bulkErrorsMore', {
                      count: allConfiguredInputDefaults.length - configuredInputDefaults.length,
                    })}
                  </small>
                )}
              </FormDisclosure>
            )}

            <div className="ai-value-preview" data-testid="authoring-value-preview">
              <div className="split-row">
                <strong>{t('recoveryCenter.validation.kicker')}</strong>
                {zeroCallLocalProposal && (
                  <span className="mode-pill mode-pill-fallback">{t('aiStudio.proposal.localTitle')}</span>
                )}
              </div>
              <dl className="ai-proposal-facts">
                <div><dt>{t('aiStudio.proposal.build')}</dt><dd>{formatAuthoringDuration(authoringElapsedMs)}</dd></div>
                <div><dt>{t('aiStudio.brief.effects')}</dt><dd>{externalWriteCount}</dd></div>
                <div><dt>{t('aiStudio.assurance.heading')}</dt><dd>{assuranceLayerCount}/3</dd></div>
                <div><dt>{t('aiStudio.binding.incomplete')}</dt><dd>{proposal.bindings.missing.length}</dd></div>
              </dl>
              <p className="helper-text">{t('aiStudio.apply.appliedBody')}</p>
            </div>

            <div className="ai-assurance-summary" role="status" data-testid="workflow-assurance-summary">
              <span className="helper-text">{t('aiStudio.assurance.heading')}</span>
              {proposal.proposal.qualification.intent && <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.intent')}</span>}
              {proposal.proposal.qualification.recovery && <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.recovery')}</span>}
              {proposal.proposal.qualification.semantic && <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.qualification')}</span>}
            </div>

            {proposal.proposal.readiness.issues.length > 0 && (
              <FormDisclosure summary={t('aiStudio.proposal.readinessIssues')}>
                <ul className="ai-proposal-issues">
                  {proposal.proposal.readiness.issues.map((issue, index) => (
                    <li key={[issue.code, index].join('-')}>
                      <strong>{issue.code}</strong>
                      <span>{issue.message}</span>
                      {issue.suggestion && <small>{issue.suggestion}</small>}
                    </li>
                  ))}
                </ul>
              </FormDisclosure>
            )}

            {(proposal.proposal.assumptions.length > 0 || proposal.proposal.risks.length > 0) && (
              <FormDisclosure summary={t('aiStudio.proposal.assumptionsRisks')}>
                <ul className="ai-proposal-signals">
                  {[...proposal.proposal.assumptions, ...proposal.proposal.risks].map((signal) => (
                    <li key={signal}>{t(SIGNAL_COPY_KEYS[signal] ?? 'aiStudio.proposal.signal.other', { signal })}</li>
                  ))}
                </ul>
              </FormDisclosure>
            )}
          </div>
        )}
      </section>

      <section className="we-card ai-authoring-stage ai-proposal-apply">
        <div>
          <div className="section-kicker">{t('aiStudio.steps.apply')}</div>
          <strong>{t('aiStudio.apply.heading')}</strong>
          <p className="helper-text">{t('aiStudio.apply.body')}</p>
        </div>
        {proposal && !proposalCatalogCurrent ? (
          <StatusSummary
            role="status"
            tone="warning"
            title={t('aiStudio.apply.blocked')}
            description={t('aiStudio.brief.questions')}
          />
        ) : proposal && !proposalApplicable && (
          <StatusSummary
            role="status"
            tone="warning"
            title={t('aiStudio.apply.blocked')}
            description={t('aiStudio.apply.blockedBody')}
          />
        )}
        {applied && (
          <StatusSummary
            role="status"
            tone="success"
            title={t('aiStudio.apply.applied')}
            description={t('aiStudio.apply.appliedBody')}
          />
        )}
        <FormActions>
          <Button
            variant="primary"
            leadingIcon={<CheckCircle2 size={16} />}
            loading={authoringLoading === 'apply'}
            loadingLabel={t('aiStudio.apply.applying')}
            disabled={!proposalApplicable}
            onClick={() => { void applyProposal() }}
          >
            {t('aiStudio.apply.action')}
          </Button>
        </FormActions>
      </section>

      {authoringError && (
        <StatusSummary role="alert" tone="danger" title={t('aiStudio.authoring.failed')} description={authoringError} />
      )}
    </>
  )
}
