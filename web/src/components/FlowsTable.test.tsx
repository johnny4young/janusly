import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DEFAULT_FLOWS_SORT, nextFlowsSort, type FlowsSort } from '../flows-filters'
import { FlowsTable } from './FlowsTable'

const t = ((key: string) => key) as Parameters<typeof FlowsTable>[0]['t']

function Harness() {
  const [sort, setSort] = useState<FlowsSort>(DEFAULT_FLOWS_SORT)
  return (
    <FlowsTable sort={sort} onSort={(key) => setSort(current => nextFlowsSort(current, key))} t={t}>
      <tr><td>row</td></tr>
    </FlowsTable>
  )
}

describe('<FlowsTable />', () => {
  it('labels every data column', () => {
    render(<Harness />)
    const table = screen.getByRole('table', { name: 'workflowsDashboard.tableAria' })
    expect(within(table).getAllByRole('columnheader')).toHaveLength(7)
    for (const column of ['Name', 'Status', 'OpenFailures', 'Health', 'LastRun', 'Version', 'Actions']) {
      expect(within(table).getByRole('columnheader', { name: `workflowsDashboard.column${column}` })).toBeInTheDocument()
    }
  })

  it('exposes the sort through aria-sort and starts on the most recent run', () => {
    render(<Harness />)
    expect(screen.getByRole('columnheader', { name: 'workflowsDashboard.columnLastRun' })).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getByRole('columnheader', { name: 'workflowsDashboard.columnName' })).toHaveAttribute('aria-sort', 'none')
    expect(screen.getByRole('columnheader', { name: 'workflowsDashboard.columnActions' })).not.toHaveAttribute('aria-sort')
  })

  it('changes and flips the sort, keeping the same control', () => {
    render(<Harness />)
    const header = screen.getByRole('columnheader', { name: 'workflowsDashboard.columnOpenFailures' })
    const button = screen.getByTestId('workflows-sort-openFailures')

    fireEvent.click(button)
    expect(header).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getByRole('columnheader', { name: 'workflowsDashboard.columnLastRun' })).toHaveAttribute('aria-sort', 'none')

    fireEvent.click(button)
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(screen.getByTestId('workflows-sort-openFailures')).toBe(button)
  })

  it.each(['name', 'status', 'openFailures', 'health', 'lastRun', 'version'])('offers a %s sort control', (key) => {
    render(<Harness />)
    expect(screen.getByTestId(`workflows-sort-${key}`).tagName).toBe('BUTTON')
  })
})
