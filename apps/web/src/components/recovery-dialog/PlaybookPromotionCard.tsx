/** Manual draft → active promotion UI shown after a proven recovery apply. */

import { useState } from 'react'
import { BookPlus, CheckCircle2, ShieldCheck } from 'lucide-react'
import { api } from '../../api'
import { useT } from '../../i18n'
import { useWorkflowStore } from '../../store'
import type { RecoveryPlaybookPromotionSource, RecoveryPlaybookSummary } from './types'

type PromotionState =
  | { kind: 'idle' }
  | { kind: 'form' }
  | { kind: 'saving' }
  | { kind: 'draft'; playbook: RecoveryPlaybookSummary }
  | { kind: 'activating'; playbook: RecoveryPlaybookSummary }
  | { kind: 'active'; playbook: RecoveryPlaybookSummary }
  | { kind: 'error'; message: string }

export function PlaybookPromotionCard({ source }: { source: RecoveryPlaybookPromotionSource }) {
  const { t } = useT()
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const [state, setState] = useState<PromotionState>({ kind: 'idle' })
  const [title, setTitle] = useState(source.defaultTitle)
  const [instructions, setInstructions] = useState(source.defaultInstructions)

  const createDraft = async () => {
    setState({ kind: 'saving' })
    try {
      const result = await api('/recovery/playbooks', {
        method: 'POST',
        body: JSON.stringify({
          deadLetterId: source.deadLetterId,
          validationRunId: source.validationRunId,
          sourceWorkflowVersionId: source.sourceWorkflowVersionId,
          title,
          instructionsMarkdown: instructions,
        }),
      }) as { playbook: RecoveryPlaybookSummary }
      setState(result.playbook.status === 'active'
        ? { kind: 'active', playbook: result.playbook }
        : { kind: 'draft', playbook: result.playbook })
      bumpPlatformVersion()
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : (t('recoveryDialog.playbook.createFailed') as string) })
    }
  }

  const activate = async (playbook: RecoveryPlaybookSummary) => {
    setState({ kind: 'activating', playbook })
    try {
      const result = await api(`/recovery/playbooks/${encodeURIComponent(playbook.id)}/activate`, {
        method: 'POST',
        body: JSON.stringify({}),
      }) as { playbook: RecoveryPlaybookSummary }
      setState({ kind: 'active', playbook: result.playbook })
      bumpPlatformVersion()
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : (t('recoveryDialog.playbook.activateFailed') as string) })
    }
  }

  if (state.kind === 'idle') {
    return (
      <section className="we-recovery-playbook-promotion" data-testid="recovery-playbook-promotion">
        <div>
          <div className="section-kicker">{t('recoveryDialog.playbook.promoteKicker')}</div>
          <strong>{t('recoveryDialog.playbook.promoteTitle')}</strong>
          <p className="helper-text">{t('recoveryDialog.playbook.promoteBody')}</p>
        </div>
        <button type="button" className="command-button" onClick={() => setState({ kind: 'form' })}>
          <BookPlus size={14} aria-hidden="true" />
          <span>{t('recoveryDialog.playbook.create')}</span>
        </button>
      </section>
    )
  }

  if (state.kind === 'form' || state.kind === 'saving') {
    return (
      <section className="we-recovery-playbook-promotion" data-testid="recovery-playbook-form">
        <div className="field-group">
          <label htmlFor="recovery-playbook-title">{t('recoveryDialog.playbook.titleLabel')}</label>
          <input
            id="recovery-playbook-title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            disabled={state.kind === 'saving'}
          />
        </div>
        <div className="field-group">
          <label htmlFor="recovery-playbook-instructions">{t('recoveryDialog.playbook.instructionsLabel')}</label>
          <textarea
            id="recovery-playbook-instructions"
            value={instructions}
            maxLength={4000}
            rows={4}
            onChange={(event) => setInstructions(event.target.value)}
            disabled={state.kind === 'saving'}
          />
        </div>
        <p className="helper-text">{t('recoveryDialog.playbook.draftNotice')}</p>
        <div className="we-recovery-playbook__actions">
          <button type="button" className="command-button" disabled={state.kind === 'saving'} onClick={() => setState({ kind: 'idle' })}>
            {t('recoveryDialog.playbook.back')}
          </button>
          <button
            type="button"
            className="command-button command-button-primary"
            disabled={state.kind === 'saving' || title.trim().length === 0 || instructions.trim().length === 0}
            onClick={() => void createDraft()}
          >
            <BookPlus size={14} aria-hidden="true" />
            <span>{state.kind === 'saving' ? t('recoveryDialog.playbook.creating') : t('recoveryDialog.playbook.saveDraft')}</span>
          </button>
        </div>
      </section>
    )
  }

  if (state.kind === 'draft' || state.kind === 'activating') {
    const playbook = state.playbook
    return (
      <section className="we-recovery-playbook-promotion" data-testid="recovery-playbook-draft">
        <header className="we-recovery-playbook__header">
          <CheckCircle2 size={18} aria-hidden="true" />
          <div><div className="section-kicker">{t('recoveryDialog.playbook.draft')}</div><strong>{playbook.title}</strong></div>
          <span className="we-recovery-playbook__version">v{playbook.version}</span>
        </header>
        <p className="helper-text">{t('recoveryDialog.playbook.activateNotice')}</p>
        <button
          type="button"
          className="command-button command-button-primary"
          disabled={state.kind === 'activating'}
          onClick={() => void activate(playbook)}
        >
          <ShieldCheck size={14} aria-hidden="true" />
          <span>{state.kind === 'activating' ? t('recoveryDialog.playbook.activating') : t('recoveryDialog.playbook.activate')}</span>
        </button>
      </section>
    )
  }

  if (state.kind === 'active') {
    return (
      <section className="we-recovery-playbook-promotion we-recovery-playbook-promotion--active" data-testid="recovery-playbook-active" role="status">
        <ShieldCheck size={18} aria-hidden="true" />
        <div><strong>{t('recoveryDialog.playbook.activeTitle')}</strong><p className="helper-text">{t('recoveryDialog.playbook.activeBody')}</p></div>
      </section>
    )
  }

  return (
    <section className="we-recovery-playbook-promotion" data-testid="recovery-playbook-error" role="alert">
      <div><strong>{t('recoveryDialog.playbook.errorTitle')}</strong><p className="helper-text">{state.message}</p></div>
      <button type="button" className="command-button" onClick={() => setState({ kind: 'form' })}>{t('recoveryDialog.footer.retry')}</button>
    </section>
  )
}
