import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowStore } from '../store'
import { BudgetBlockedBanner } from './BudgetBlockedBanner'

const initialState = useWorkflowStore.getState()

describe('<BudgetBlockedBanner />', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initialState, budgetBlocked: null }, true)
  })

  it('renders nothing when no budget block envelope is present', () => {
    const { container } = render(<BudgetBlockedBanner onOpenTab={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('surfaces the latest 402 envelope and clears it from the Operations CTA', () => {
    const onOpenTab = vi.fn()
    useWorkflowStore.getState().setBudgetBlocked({
      monthlyUsdSpent: 12,
      monthlyUsdLimit: 10,
      exceededAt: 'workflow',
      policy: 'block',
    })

    render(<BudgetBlockedBanner onOpenTab={onOpenTab} />)

    expect(screen.getByRole('alert')).toHaveTextContent('AI workflow budget exceeded')
    expect(screen.getByText('$12.00')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('budget-blocked-banner-cta'))

    expect(onOpenTab).toHaveBeenCalledWith('operations')
    expect(useWorkflowStore.getState().budgetBlocked).toBeNull()
  })

  it('can be dismissed without changing tabs', () => {
    const onOpenTab = vi.fn()
    useWorkflowStore.getState().setBudgetBlocked({
      monthlyUsdSpent: 11,
      monthlyUsdLimit: 10,
      exceededAt: 'org',
      policy: 'block',
    })

    render(<BudgetBlockedBanner onOpenTab={onOpenTab} />)
    fireEvent.click(screen.getByTestId('budget-blocked-banner-dismiss'))

    expect(onOpenTab).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().budgetBlocked).toBeNull()
  })
})
