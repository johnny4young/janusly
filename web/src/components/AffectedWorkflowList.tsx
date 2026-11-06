import { Workflow } from 'lucide-react'

import { useT } from '../i18n'
import type { SavedWorkflow } from '../types'

export type WorkflowLabels = readonly Pick<SavedWorkflow, 'id' | 'name'>[]

/** Names are display-only: an id missing from `workflows` still gets a row, labelled by its id. */
export function AffectedWorkflowList({ workflowIds, workflows }: { workflowIds: readonly string[]; workflows: WorkflowLabels }) {
  const { t } = useT()
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]))
  return (
    <>
      <h3 id="affected-workflows-heading" className="section-title">
        {t('credentialRotation.preview.affectedHeading', { count: workflowIds.length })}
      </h3>
      {workflowIds.length === 0 ? (
        <p className="helper-text">{t('credentialRotation.preview.none')}</p>
      ) : (
        <ul
          className="we-affected-workflows__list"
          aria-labelledby="affected-workflows-heading"
          tabIndex={0}
        >
          {workflowIds.map((id) => (
            <li key={id} className="we-affected-workflows__row">
              <Workflow size={14} aria-hidden="true" />
              <strong>{names.get(id) ?? id}</strong>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
