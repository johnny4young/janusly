/**
 * Schema-driven dialog for a paused `human_form` node. Reuses the run-input
 * renderer so operators get the same field behaviour at workflow start and
 * mid-run resume.
 *
 * Used by `RightPanel.tsx` when a run node is waiting on structured human
 * input.
 */

import React from 'react'
import type { WorkflowInputSchemaShape } from '../types'
import { RunInputDialog } from './RunInputDialog'
import { useT } from '../i18n'

type HumanFormDialogProps = {
  title?: string
  description?: string
  schema: WorkflowInputSchemaShape
  serverErrors?: string[]
  submitting?: boolean
  onSubmit: (input: unknown) => void | Promise<void>
  onCancel: () => void
}

/** Render a focused submit dialog for a waiting human-form step. */
export function HumanFormDialog({
  title,
  description,
  schema,
  serverErrors,
  submitting,
  onSubmit,
  onCancel,
}: HumanFormDialogProps) {
  const { t } = useT()
  return (
    <RunInputDialog
      inputs={schema}
      kicker={t('humanFormDialog.kicker')}
      title={title?.trim() || t('humanFormDialog.title')}
      description={description?.trim() || t('humanFormDialog.description')}
      submitLabel={t('humanFormDialog.submit')}
      submittingLabel={t('humanFormDialog.submitting')}
      closeLabel={t('humanFormDialog.close')}
      serverErrors={serverErrors}
      submitting={submitting}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )
}
