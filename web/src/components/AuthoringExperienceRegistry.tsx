import { BriefFacts } from './BriefFacts'
import { ownAuthoringExperience } from '../lib/experience-authority'
import { useEffect, useRef, useState } from 'react'
import { apiErrorStatus, contractApi } from '../api'
import { useT } from '../i18n'
import { sessionCan } from '../identity-context'
import { useWorkflowStore } from '../store'
import { currentAuthoringAuthority } from '../lib/canvas-authority'
import { invalidateTags } from '../lib/query-cache'
import type { AuthoringExperienceList, AuthoringExperienceRecord } from '../lib/api-types.generated'
import type { WorkflowVersionRow } from '../lib/list-contract'
import type { WorkflowBriefCompilation } from '../types'
import { isGetAuthoringExperiencesResponse } from '../lib/api-guards/operations/GetAuthoringExperiences'
import { isPostAuthoringExperiencesRegisterResponse } from '../lib/api-guards/operations/PostAuthoringExperiencesRegister'
import { isPostAuthoringExperiencesRevokeResponse } from '../lib/api-guards/operations/PostAuthoringExperiencesRevoke'
import { isPostAiWorkflowBriefsCompileResponse } from '../lib/api-guards/operations/PostAiWorkflowBriefsCompile'
import { MAX_AUTHORING_PROMPT_CHARS } from './ai-studio/model'
import { Button } from './ui/Button'
import { FormActions, FormDisclosure, FormField, SelectControl, TextAreaControl } from './ui/Form'

function registryAuthority(state = useWorkflowStore.getState()): string {
  return JSON.stringify([currentAuthoringAuthority(state), state.currentWorkflowSaved])
}
function boundedSource(row: AuthoringExperienceRecord, workflowId: string): boolean {
  return row.workflowId === workflowId && row.version > 0
    && [row.id, row.workflowId, row.versionId].every(value => value.trim() === value && value.length > 0
      && new TextEncoder().encode(value).length <= 128 && !/[\x00-\x1f\x7f]/.test(value))
    && Number.isFinite(Date.parse(row.registeredAt)) && Date.parse(row.retainUntil) > Date.parse(row.registeredAt)
}
export default function AuthoringExperienceRegistry({ versions }: { versions: readonly WorkflowVersionRow[] }) {
  const scope = useWorkflowStore(registryAuthority)
  const state = useWorkflowStore.getState()
  if (!state.currentWorkflowSaved || !state.currentWorkflowId
    || !['ai.write', 'workflows.read', 'workflows.write'].every(permission => sessionCan(state.identityContext, permission))) return null
  return <ScopedRegistry key={scope} workflowId={state.currentWorkflowId} versions={versions} />
}
function ScopedRegistry({ workflowId, versions }: { workflowId: string; versions: readonly WorkflowVersionRow[] }) {
  const { t } = useT()
  const [list, setList] = useState<AuthoringExperienceList | null>(null)
  const [prompt, setPrompt] = useState('')
  const [selected, setSelected] = useState('')
  const [compiled, setCompiled] = useState<WorkflowBriefCompilation | null>(null)
  const [busy, setBusy] = useState<'compile' | 'register' | 'revoke' | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const owner = useRef<AbortController | null>(null)
  const operation = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const version = versions.find(row => row.id === (selected || versions[0]?.id))
  const current = (request: AbortController, id: number) => !request.signal.aborted && !owner.current?.signal.aborted && generation.current === id
  useEffect(() => {
    const invalidate = () => { operation.current?.abort(); generation.current += 1; setRetry(value => value + 1) }
    const request = ownAuthoringExperience(invalidate, registryAuthority)
    owner.current = request
    setList(null); setCompiled(null); setBusy(null); setPrompt(''); setError(false)
    void contractApi('GET /authoring/experiences', `/v1/authoring/experiences?workflowId=${encodeURIComponent(workflowId)}`, undefined,
      { signal: request.signal, guard: isGetAuthoringExperiencesResponse })
      .then(result => {
        if (request.signal.aborted) return
        if (result.entries.length > 5 || new Set(result.entries.map(row => row.id)).size !== result.entries.length
          || !result.entries.every(row => boundedSource(row, workflowId))) throw new Error('Invalid example list')
        setList(result)
      })
      .catch(failure => { if (!request.signal.aborted && apiErrorStatus(failure) !== 403) setError(true) })
    return () => { request.abort(); operation.current?.abort(); generation.current += 1 }
  }, [workflowId, retry])
  const edit = (value: string, versionEdit = false) => {
    operation.current?.abort(); generation.current += 1
    if (versionEdit) setSelected(value); else setPrompt(value)
    setCompiled(null); setBusy(null); setError(false)
  }
  const command = async (kind: NonNullable<typeof busy>, example?: AuthoringExperienceRecord) => {
    if (busy || !version || !owner.current || owner.current.signal.aborted) return
    if (kind === 'register' && !compiled?.complete) return
    const request = new AbortController()
    operation.current = request
    const id = ++generation.current
    const snapshot = { workflowId, versionId: version.id, version: version.version }
    setBusy(kind); setError(false)
    try {
      const brief = compiled ? structuredClone(compiled.brief) : undefined
      if (kind === 'compile') {
        const result = await contractApi('POST /ai/workflow-briefs/compile', '/ai/workflow-briefs/compile', { prompt: prompt.trim() },
          { signal: request.signal, guard: isPostAiWorkflowBriefsCompileResponse })
        if (current(request, id)) setCompiled(result)
      } else if (kind === 'register' && brief) {
        const result = await contractApi('POST /authoring/experiences/register', '/v1/authoring/experiences/register',
          { workflowId: snapshot.workflowId, versionId: snapshot.versionId, brief },
          { signal: request.signal, guard: isPostAuthoringExperiencesRegisterResponse })
        if (!current(request, id)) return
        if (!boundedSource(result, workflowId) || result.versionId !== snapshot.versionId || result.version !== snapshot.version) throw new Error('Invalid example identity')
        invalidateTags(['authoring-experiences'])
      } else if (example) {
        const result = await contractApi('POST /authoring/experiences/revoke', '/v1/authoring/experiences/revoke', { id: example.id },
          { signal: request.signal, guard: isPostAuthoringExperiencesRevokeResponse })
        if (!current(request, id)) return
        if (result.id !== example.id) throw new Error('Invalid withdrawal identity')
        invalidateTags(['authoring-experiences'])
      }
    } catch { if (current(request, id)) setError(true) }
    finally { if (current(request, id)) setBusy(null) }
  }
  if (!list) return error ? <div role="status"><p>{t('versionHistory.experience.failed')}</p><Button size="sm" onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</Button></div> : null
  const mutating = busy === 'register' || busy === 'revoke'
  return <FormDisclosure summary={t('versionHistory.experience.heading')} open>
    <p>{t('versionHistory.experience.unknown')}</p>
    <FormField label={t('versionHistory.experience.version')}>
      {props => <SelectControl {...props} value={version?.id ?? ''} disabled={mutating} onChange={event => edit(event.target.value, true)}>
        {versions.map(row => <option key={row.id} value={row.id}>v{row.version}</option>)}
      </SelectControl>}
    </FormField>
    <FormField label={t('versionHistory.experience.intent')}>
      {props => <TextAreaControl {...props} value={prompt} maxLength={MAX_AUTHORING_PROMPT_CHARS} disabled={mutating} onChange={event => edit(event.target.value)} />}
    </FormField>
    <FormActions>
      <Button size="sm" disabled={!prompt.trim() || busy !== null} loading={busy === 'compile'} onClick={() => { void command('compile') }}>{t('versionHistory.experience.compile')}</Button>
      <Button size="sm" variant="primary" disabled={!compiled?.complete || !version || busy !== null} loading={busy === 'register'} onClick={() => { void command('register') }}>{t('versionHistory.experience.register')}</Button>
    </FormActions>
    {compiled && <div data-testid="registered-example-brief">
      <BriefFacts brief={compiled.brief} /><BriefFacts brief={compiled.brief} details />
      <small>{compiled.brief.language} · v{compiled.brief.version}</small>
      {compiled.clarifyingQuestions.length > 0 && <ul>{compiled.clarifyingQuestions.map(question => <li key={question}>{question}</li>)}</ul>}
    </div>}
    {error && <p role="alert">{t('versionHistory.experience.failed')}</p>}
    {list.entries.map(example => <div key={example.id}>
      <span>{t('versionHistory.experience.source', { version: example.version, versionId: example.versionId })}</span>
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void command('revoke', example) }}>{t('versionHistory.experience.withdraw', { version: example.version })}</Button>
    </div>)}
    {list.truncated && <p>{t('versionHistory.experience.truncated')}</p>}
  </FormDisclosure>
}
