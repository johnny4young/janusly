import { lazy, Suspense } from 'react'

import { useT } from '../i18n'
import type { ToolInputFieldsProps } from './ToolInputFields'

const ToolInputFields = lazy(() => import('./ToolInputFields').then(module => ({
  default: module.ToolInputFields,
})))

export function LazyToolInputFields(props: ToolInputFieldsProps) {
  const { t } = useT()
  return (
    <Suspense fallback={<p className="helper-text" role="status">{t('common.loading')}</p>}>
      <ToolInputFields {...props} />
    </Suspense>
  )
}
