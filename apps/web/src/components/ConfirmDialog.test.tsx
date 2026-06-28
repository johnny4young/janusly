import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConfirmProvider, useConfirm } from './ConfirmDialog'

/** Minimal consumer that records what the confirm promise resolves to. */
function Harness({ onResult }: { onResult: (ok: boolean) => void }) {
  const confirm = useConfirm()
  return (
    <button onClick={async () => onResult(await confirm({ body: 'Delete it?', tone: 'danger' }))}>
      open
    </button>
  )
}

function renderHarness() {
  const results: boolean[] = []
  render(
    <ConfirmProvider>
      <Harness onResult={(ok) => results.push(ok)} />
    </ConfirmProvider>,
  )
  return results
}

describe('<ConfirmProvider /> / useConfirm', () => {
  it('shows the dialog and resolves true when confirmed', async () => {
    const results = renderHarness()
    fireEvent.click(screen.getByText('open'))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('Delete it?')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() => expect(results).toEqual([true]))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('resolves false when cancelled', async () => {
    const results = renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    await waitFor(() => expect(results).toEqual([false]))
  })

  it('resolves false on Escape', async () => {
    const results = renderHarness()
    fireEvent.click(screen.getByText('open'))
    await screen.findByRole('alertdialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(results).toEqual([false]))
  })
})
