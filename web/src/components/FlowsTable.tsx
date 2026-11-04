import type { ReactNode } from 'react'
import type { FlowsSort, SortKey } from '../flows-filters'
import type { useT } from '../i18n'
import { Button } from './ui/Button'
import './FlowsTable.css'

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'workflowsDashboard.columnName' },
  { key: 'status', label: 'workflowsDashboard.columnStatus' },
  { key: 'openFailures', label: 'workflowsDashboard.columnOpenFailures' },
  { key: 'health', label: 'workflowsDashboard.columnHealth' },
  { key: 'lastRun', label: 'workflowsDashboard.columnLastRun' },
  { key: 'version', label: 'workflowsDashboard.columnVersion' },
]

export function FlowsTable({ sort, onSort, t, children }: {
  sort: FlowsSort
  onSort: (key: SortKey) => void
  t: ReturnType<typeof useT>['t']
  children: ReactNode
}) {
  return (
    <div className="we-flows-table-wrap">
      <table className="we-flows-table" aria-label={t('workflowsDashboard.tableAria')}>
        <thead>
          <tr>
            {COLUMNS.map(({ key, label }) => {
              const active = sort.key === key
              return (
                <th
                  key={key}
                  scope="col"
                  data-column={key}
                  aria-sort={!active ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending'}
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    className="we-flows-table__sort"
                    data-active={active ? 'true' : undefined}
                    trailingIcon={!active ? '↕' : sort.direction === 'asc' ? '↑' : '↓'}
                    onClick={() => onSort(key)}
                    data-testid={`workflows-sort-${key}`}
                  >
                    {t(label)}
                  </Button>
                </th>
              )
            })}
            <th scope="col" data-column="actions"><span className="we-sr-only">{t('workflowsDashboard.columnActions')}</span></th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
