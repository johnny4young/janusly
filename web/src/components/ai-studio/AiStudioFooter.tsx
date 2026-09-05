import { useMemo } from 'react'
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  GitBranch,
  KeyRound,
  MessageSquareText,
  RefreshCw,
  Route,
  Workflow,
} from 'lucide-react'
import { useT } from '../../i18n'
import { Button } from '../ui/Button'
import type { AiStudioModel } from './useAiStudioController'

export function AiStudioFooter({ model }: { model: AiStudioModel }) {
  const { t, i18n } = useT()
  const locale = i18n.resolvedLanguage
  const { health, onOpenRuns, onOpenTemplates } = model
  const useCases = useMemo(() => [
    {
      icon: <Workflow size={16} />,
      title: t('aiStudio.useCase.prompt.title'),
      body: t('aiStudio.useCase.prompt.body'),
      state: health?.enabled ? t('aiStudio.useCase.prompt.stateOn') : t('aiStudio.useCase.prompt.stateOff'),
    },
    {
      icon: <MessageSquareText size={16} />,
      title: t('aiStudio.useCase.explain.title'),
      body: t('aiStudio.useCase.explain.body'),
      state: health?.enabled ? t('aiStudio.useCase.prompt.stateOn') : t('aiStudio.useCase.explain.stateOff'),
    },
    {
      icon: <Bot size={16} />,
      title: t('aiStudio.useCase.explainRun.title'),
      body: t('aiStudio.useCase.explainRun.body'),
      state: health?.enabled ? t('aiStudio.useCase.explainRun.stateOn') : t('aiStudio.useCase.explainRun.stateOff'),
    },
    {
      icon: <BrainCircuit size={16} />,
      title: t('aiStudio.useCase.agent.title'),
      body: t('aiStudio.useCase.agent.body'),
      state: health?.enabled ? t('aiStudio.useCase.agent.stateOn') : t('aiStudio.useCase.agent.stateOff'),
    },
    {
      icon: <Route size={16} />,
      title: t('aiStudio.useCase.causal.title'),
      body: t('aiStudio.useCase.causal.body'),
      state: t('aiStudio.useCase.causal.alwaysOn'),
    },
  ], [health?.enabled, locale, t])
  const readinessSteps = useMemo(() => [
    {
      icon: <KeyRound size={15} />,
      title: t('aiStudio.readiness.envTitle'),
      body: t('aiStudio.readiness.envBody'),
      ready: Boolean(health?.enabled),
    },
    {
      icon: <RefreshCw size={15} />,
      title: t('aiStudio.readiness.restartTitle'),
      body: t('aiStudio.readiness.restartBody'),
      ready: Boolean(health),
    },
    {
      icon: <CheckCircle2 size={15} />,
      title: t('aiStudio.readiness.healthTitle'),
      body: health?.enabled
        ? t('aiStudio.readiness.healthBodyOn', { model: health.model })
        : t('aiStudio.readiness.healthBodyOff'),
      ready: Boolean(health?.enabled),
    },
  ], [health, locale, t])
  return (
    <>
      <section className="we-card">
        <div className="section-kicker">{t('aiStudio.useCases')}</div>
        <div className="usecase-list">
          {useCases.map((useCase) => (
            <div key={useCase.title} className="usecase-row">
              <div className="usecase-icon">{useCase.icon}</div>
              <div>
                <strong>{useCase.title}</strong>
                <p>{useCase.body}</p>
              </div>
              <span className="mode-pill mode-pill-neutral">{useCase.state}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="we-card">
        <div className="section-kicker">{t('aiStudio.readiness.heading')}</div>
        <div className="usecase-list">
          {readinessSteps.map((step) => (
            <div key={step.title} className="usecase-row">
              <div className={step.ready ? 'usecase-icon usecase-icon-ready' : 'usecase-icon'}>{step.icon}</div>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
              <span className={step.ready ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
                {step.ready ? t('aiStudio.readiness.ready') : t('aiStudio.readiness.check')}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="ai-studio-secondary-actions">
        <Button leadingIcon={<MessageSquareText size={16} />} onClick={onOpenRuns}>
          {t('aiStudio.askAboutRun')}
        </Button>
        <Button leadingIcon={<GitBranch size={16} />} onClick={onOpenTemplates}>
          {t('aiStudio.browseRecipes')}
        </Button>
      </section>
    </>
  )
}
