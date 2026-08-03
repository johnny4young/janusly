import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react'
import { CalendarClock, Gauge, GitBranch, History, Info } from 'lucide-react'

import { useT } from '../i18n'

const VersionHistoryPanel = lazy(() => import('./VersionHistoryPanel').then((module) => ({ default: module.VersionHistoryPanel })))
const WorkflowRolloutPanel = lazy(() => import('./WorkflowRolloutPanel').then((module) => ({ default: module.WorkflowRolloutPanel })))
const WorkflowSloPanel = lazy(() => import('./WorkflowSloPanel').then((module) => ({ default: module.WorkflowSloPanel })))
const ScheduleHistoryPanel = lazy(() => import('./ScheduleHistoryPanel').then((module) => ({ default: module.ScheduleHistoryPanel })))
const WorkflowMetadataPanel = lazy(() => import('./WorkflowMetadataPanel').then((module) => ({ default: module.WorkflowMetadataPanel })))

type WorkflowOperationsSection = 'versions' | 'deployment' | 'reliability' | 'schedule' | 'about'

type ControlProps = { readOnly?: boolean }

const VersionsControl = () => <VersionHistoryPanel />
const DeploymentControl = ({ readOnly }: ControlProps) => <WorkflowRolloutPanel readOnly={readOnly} />
const ReliabilityControl = ({ readOnly }: ControlProps) => <WorkflowSloPanel readOnly={readOnly} />
const ScheduleControl = () => <ScheduleHistoryPanel />
const AboutControl = ({ readOnly }: ControlProps) => <WorkflowMetadataPanel readOnly={readOnly} />

type SectionDefinition = {
  id: WorkflowOperationsSection
  labelKey: string
  icon: ReactNode
  component: ComponentType<ControlProps>
}

const SECTIONS: readonly SectionDefinition[] = [
  { id: 'versions', labelKey: 'authoring.workflowTools.versions', icon: <History size={14} />, component: VersionsControl },
  { id: 'deployment', labelKey: 'authoring.workflowTools.deployment', icon: <GitBranch size={14} />, component: DeploymentControl },
  { id: 'reliability', labelKey: 'authoring.workflowTools.reliability', icon: <Gauge size={14} />, component: ReliabilityControl },
  { id: 'schedule', labelKey: 'authoring.workflowTools.schedule', icon: <CalendarClock size={14} />, component: ScheduleControl },
  { id: 'about', labelKey: 'authoring.workflowTools.about', icon: <Info size={14} />, component: AboutControl },
]

export function WorkflowOperationsPanel({ readOnly }: { readOnly: boolean }) {
  const { t } = useT()
  const [activeSection, setActiveSection] = useState<WorkflowOperationsSection | null>(null)
  const selected = SECTIONS.find((section) => section.id === activeSection)
  const SelectedPanel = selected?.component

  return (
    <section className="authoring-workflow-tools" aria-labelledby="authoring-workflow-tools-title">
      <div className="authoring-workflow-tools__heading">
        <strong id="authoring-workflow-tools-title">{t('authoring.workflowTools.title')}</strong>
        <span>{t('authoring.workflowTools.description')}</span>
      </div>
      <div className="authoring-workflow-tools__nav" role="group" aria-label={t('authoring.workflowTools.aria')}>
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className="small-command"
            aria-pressed={section.id === activeSection}
            onClick={() => setActiveSection((current) => current === section.id ? null : section.id)}
          >
            {section.icon}
            <span>{t(section.labelKey)}</span>
          </button>
        ))}
      </div>
      {SelectedPanel && (
        <Suspense fallback={<p className="helper-text" role="status">{t('common.working')}</p>}>
          <SelectedPanel readOnly={readOnly} />
        </Suspense>
      )}
    </section>
  )
}
