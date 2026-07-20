import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useWorkflowStore } from '../store'
import { UserMenu } from './UserMenu'

const initialState = useWorkflowStore.getState()

beforeEach(() => {
  useWorkflowStore.setState({
    ...initialState,
    userId: 'dev-user',
    orgId: 'default',
    authReady: true,
    onboarding: null,
  }, true)
})

describe('<UserMenu /> docs capability', () => {
  it('omits the Docs item when no URL is configured', () => {
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }))
    expect(screen.queryByRole('link', { name: 'Docs & changelog' })).not.toBeInTheDocument()
  })

  it('omits the Docs item when the configured value is not safe HTTPS', () => {
    render(<UserMenu docsUrl="javascript:alert(1)" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }))
    expect(screen.queryByRole('link', { name: 'Docs & changelog' })).not.toBeInTheDocument()
  })

  it('renders a safe external Docs link when configured', () => {
    render(<UserMenu docsUrl="https://docs.example.com/start" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open user menu' }))

    const docs = screen.getByRole('link', { name: 'Docs & changelog' })
    expect(docs).toHaveAttribute('href', 'https://docs.example.com/start')
    expect(docs).toHaveAttribute('target', '_blank')
    expect(docs).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
