/**
 * RecoveryCenterEmptyState — the headline visual of the Home when there's
 * no real activity yet.
 *
 * `RecoveryFlowDemo` showcases Janusly's differentiator (the recovery
 * loop) as a 4-step horizontal flow: failure → 3 AI suggestions w/
 * confidence → sandbox replay → apply across the failure cluster, with a
 * rollback hint. Static markup (no animation) — the goal is to TEACH the
 * loop, not to delight. Tokens-only colors; honors `prefers-reduced-motion`
 * for hover.
 *
 * Used by `../RecoveryCenterPanel.tsx` (the composer renders it inside the
 * operator chat column when the workspace is empty).
 */

import {
  AlertOctagon,
  ArrowRight,
  Check,
  FlaskConical,
  Layers,
  PlayCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Wand2,
  Workflow,
  X,
} from 'lucide-react'
import { useT } from '../../i18n'

export function RecoveryFlowDemo({
  onOpenStudio,
  onOpenRecipes,
  onTryDemo,
  onDismiss,
}: {
  onOpenStudio: () => void
  onOpenRecipes: () => void
  /** When set, renders a primary "try a demo recovery" CTA that injects a real
   *  demo failure so the operator can experience the loop, not just read it. */
  onTryDemo?: () => void | Promise<void>
  /** When set, renders a dismiss control that hides the walkthrough for good. */
  onDismiss?: () => void
}) {
  const { t } = useT()
  return (
    <section className="we-flow-demo" aria-labelledby="we-flow-demo-title" data-testid="recovery-flow-demo">
      {onDismiss && (
        <button
          type="button"
          className="we-flow-demo__dismiss"
          onClick={onDismiss}
          aria-label={t('recoveryCenter.flowDemo.dismiss') as string}
          data-testid="recovery-flow-demo-dismiss"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
      <header className="we-flow-demo__head">
        <div>
          <div className="section-kicker">{t('recoveryCenter.flowDemo.kicker')}</div>
          <h2 id="we-flow-demo-title">{t('recoveryCenter.flowDemo.title')}</h2>
          <p>{t('recoveryCenter.flowDemo.body')}</p>
        </div>
        <div className="we-flow-demo__ctas">
          {onTryDemo && (
            <button
              type="button"
              className="command-button command-button-primary"
              onClick={() => void onTryDemo()}
              data-testid="recovery-center-empty-cta-demo"
            >
              <PlayCircle size={14} aria-hidden="true" />
              <span>{t('recoveryCenter.flowDemo.cta.tryDemo')}</span>
            </button>
          )}
          <button
            type="button"
            className={onTryDemo ? 'command-button' : 'command-button command-button-primary'}
            onClick={onOpenStudio}
            data-testid="recovery-center-empty-cta-studio"
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>{t('recoveryCenter.flowDemo.cta.studio')}</span>
          </button>
          <button
            type="button"
            className="command-button"
            onClick={onOpenRecipes}
            data-testid="recovery-center-empty-cta-recipes"
          >
            <Workflow size={14} aria-hidden="true" />
            <span>{t('recoveryCenter.flowDemo.cta.recipes')}</span>
          </button>
        </div>
      </header>

      <ol className="we-flow-demo__steps">
        <li className="we-flow-demo__step" data-step="failure" data-testid="recovery-flow-demo-step-1">
          <span className="we-flow-demo__step-num">1</span>
          <span className="we-flow-demo__step-ic" aria-hidden="true"><AlertOctagon size={16} /></span>
          <strong>{t('recoveryCenter.flowDemo.step1.title')}</strong>
          <code className="we-flow-demo__sig">0x9af2</code>
          <span className="we-flow-demo__step-meta">stripe.charge · secret_missing</span>
        </li>
        <span className="we-flow-demo__arrow" aria-hidden="true"><ArrowRight size={14} /></span>
        <li className="we-flow-demo__step" data-step="suggest" data-testid="recovery-flow-demo-step-2">
          <span className="we-flow-demo__step-num">2</span>
          <span className="we-flow-demo__step-ic" aria-hidden="true"><Wand2 size={16} /></span>
          <strong>{t('recoveryCenter.flowDemo.step2.title')}</strong>
          <span className="we-flow-demo__confidence-strip">
            <span className="we-flow-demo__conf we-flow-demo__conf--top">92 AI</span>
            <span className="we-flow-demo__conf">78 AI</span>
            <span className="we-flow-demo__conf we-flow-demo__conf--low">55 AI</span>
          </span>
          <span className="we-flow-demo__step-meta">{t('recoveryCenter.flowDemo.step2.meta')}</span>
        </li>
        <span className="we-flow-demo__arrow" aria-hidden="true"><ArrowRight size={14} /></span>
        <li className="we-flow-demo__step" data-step="sandbox" data-testid="recovery-flow-demo-step-3">
          <span className="we-flow-demo__step-num">3</span>
          <span className="we-flow-demo__step-ic" aria-hidden="true"><FlaskConical size={16} /></span>
          <strong>{t('recoveryCenter.flowDemo.step3.title')}</strong>
          <span className="we-flow-demo__pill we-flow-demo__pill--success">
            <Check size={11} aria-hidden="true" />
            <span>412ms · signature stable</span>
          </span>
          <span className="we-flow-demo__step-meta">{t('recoveryCenter.flowDemo.step3.meta')}</span>
        </li>
        <span className="we-flow-demo__arrow" aria-hidden="true"><ArrowRight size={14} /></span>
        <li className="we-flow-demo__step" data-step="apply" data-testid="recovery-flow-demo-step-4">
          <span className="we-flow-demo__step-num">4</span>
          <span className="we-flow-demo__step-ic" aria-hidden="true"><ShieldCheck size={16} /></span>
          <strong>{t('recoveryCenter.flowDemo.step4.title')}</strong>
          <span className="we-flow-demo__pill we-flow-demo__pill--cobalt">
            <Layers size={11} aria-hidden="true" />
            <span>{t('recoveryCenter.flowDemo.step4.cluster', { count: 9 })}</span>
          </span>
          <span className="we-flow-demo__step-meta">
            <RotateCcw size={11} aria-hidden="true" />
            {t('recoveryCenter.flowDemo.step4.meta')}
          </span>
        </li>
      </ol>
    </section>
  )
}
