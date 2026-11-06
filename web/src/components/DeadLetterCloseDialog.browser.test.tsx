import { useState } from 'react'
import { page, userEvent } from 'vitest/browser'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { initI18n } from '../i18n'
import { DeadLetterCloseDialog } from './DeadLetterCloseDialog'

function Harness({ onConfirm, many = false }: { onConfirm: (reason: string) => Promise<boolean>; many?: boolean }) {
  const [open, setOpen] = useState(false)
  return <>
    <button onClick={() => setOpen(true)}>Open confirmation</button>
    {open && <DeadLetterCloseDialog
      targets={Array.from({ length: many ? 50 : 1 }, (_, i) => ({
        id: `failure-${i}-${'a'.repeat(80)}`, workflowName: 'Facturación internacional · Customer invoicing',
        runId: `run-${i}`, nodeId: 'charge-customer', occurrences: 3,
      }))}
      onConfirm={onConfirm} onClose={() => setOpen(false)} />}
  </>
}

describe('DLQ accepted-loss confirmation in Chromium', () => {
  it.each(['en', 'es'] as const)('cannot be confirmed from the keyboard until a reason is typed in %s', async locale => {
    initI18n(locale)
    const onConfirm = vi.fn(async () => true)
    render(<Harness onConfirm={onConfirm} />)
    const trigger = screen.getByRole('button', { name: 'Open confirmation' })
    await userEvent.click(trigger)
    const reason = screen.getByTestId('dlq-close-reason')
    const cancel = screen.getByTestId('dlq-close-cancel')
    const confirm = screen.getByTestId('dlq-close-confirm')
    await waitFor(() => expect(reason).toHaveFocus())
    expect(confirm).toBeDisabled()
    await userEvent.keyboard('{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()
    await userEvent.keyboard('{Tab}')
    expect(cancel).toHaveFocus()
    await userEvent.keyboard('{Tab}')
    expect(reason).toHaveFocus()
    await userEvent.fill(reason, '   ')
    expect(confirm).toBeDisabled()
    await userEvent.fill(reason, '  Refunded by hand ')
    expect(confirm).toBeEnabled()
    await userEvent.keyboard('{Tab}')
    expect(cancel).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
    await waitFor(() => expect(trigger).toHaveFocus())
    await userEvent.click(trigger)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
    await userEvent.click(trigger)
    await userEvent.fill(screen.getByTestId('dlq-close-reason'), '  Refunded by hand ')
    await userEvent.click(screen.getByTestId('dlq-close-confirm'))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Refunded by hand'))
  })

  it('keeps the reason and actions reachable on a short viewport', async () => {
    initI18n('en')
    render(<Harness onConfirm={vi.fn(async () => true)} many />)
    try {
      await page.viewport(512, 384)
      await userEvent.click(screen.getByRole('button', { name: 'Open confirmation' }))
      const submit = screen.getByTestId('dlq-close-confirm')
      await waitFor(() => expect(screen.getByTestId('dlq-close-reason')).toHaveFocus())
      const dialog = screen.getByRole('alertdialog')
      // The scope stays readable instead of collapsing to fit the fixed parts.
      expect(dialog.querySelector('.run-input-dialog__body')!.clientHeight).toBeGreaterThan(dialog.clientHeight)
      expect(getComputedStyle(dialog).overflowY).toBe('auto')
      submit.scrollIntoView()
      expect(submit.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight)
      expect(submit.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
      await userEvent.click(screen.getByTestId('dlq-close-cancel'))
    } finally {
      await page.viewport(1024, 768)
    }
  })

  it('shows workflow, step and occurrences as facts and bounds the reason', async () => {
    initI18n('en')
    render(<Harness onConfirm={vi.fn(async () => true)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open confirmation' }))
    const facts = screen.getByRole('alertdialog').querySelector('.we-dlq-close__facts')!
    expect([...facts.querySelectorAll('dt')].map(term => term.textContent)).toEqual(['Workflow', 'Step', 'Occurrences'])
    expect([...facts.querySelectorAll('dd')].map(value => value.textContent))
      .toEqual(['Facturación internacional · Customer invoicing', 'charge-customer', '3'])
    expect(screen.getByLabelText(/Reason/)).toHaveAttribute('maxlength', '280')
  })

  it('retains focus while all actions are disabled and exposes failure without success', async () => {
    let finish: (value: boolean) => void = () => { throw new Error('not submitted') }
    const onConfirm = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    render(<Harness onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open confirmation' }))
    await userEvent.fill(screen.getByTestId('dlq-close-reason'), 'Refunded by hand')
    await userEvent.click(screen.getByTestId('dlq-close-confirm'))
    const dialog = screen.getByRole('alertdialog')
    expect(screen.getByTestId('dlq-close-confirm')).toBeDisabled()
    expect(screen.getByTestId('dlq-close-cancel')).toBeDisabled()
    expect(screen.getByTestId('dlq-close-reason')).toBeDisabled()
    await userEvent.keyboard('{Tab}{Shift>}{Tab}{/Shift}{Escape}{Enter}')
    expect(dialog).toHaveFocus()
    expect(onConfirm).toHaveBeenCalledOnce()
    await act(async () => finish(false))
    expect(screen.getByRole('alert')).toHaveTextContent('No recovery is claimed')
    expect(screen.getByTestId('dlq-close-cancel')).toHaveFocus()
    expect(screen.getByTestId('dlq-close-reason')).toHaveValue('Refunded by hand')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it.each(['en', 'es'] as const)('keeps long bulk scope scrollable and actions visible in %s', async locale => {
    initI18n(locale)
    render(<Harness onConfirm={vi.fn(async () => true)} many />)
    try {
      // 512 CSS px also exercises the layout of a 1024px window at 200% zoom.
      for (const width of [390, 512, 768, 1024, 1440]) {
        await page.viewport(width, 844)
        await userEvent.click(screen.getByRole('button', { name: 'Open confirmation' }))
        const dialog = screen.getByRole('alertdialog')
        const body = dialog.querySelector('.run-input-dialog__body')!
        const submit = screen.getByTestId('dlq-close-confirm')
        const reason = screen.getByTestId('dlq-close-reason').getBoundingClientRect()
        expect(reason.top).toBeGreaterThanOrEqual(body.getBoundingClientRect().bottom)
        expect(reason.bottom).toBeLessThanOrEqual(submit.getBoundingClientRect().top)
        expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1)
        expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1)
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight)
        expect(submit.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight)
        expect(submit.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
        await userEvent.click(screen.getByTestId('dlq-close-cancel'))
      }
    } finally {
      await page.viewport(1024, 768)
    }
  })
})
