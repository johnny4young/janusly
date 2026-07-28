/**
 * Browser-mode smoke for the Login screen + LocaleSwitcher integration.
 * Validates that:
 *  1. The form mounts in English by default.
 *  2. Picking 'es' from the corner switcher swaps the visible labels
 *     in real time without reload.
 *  3. The choice is persisted to localStorage under 'janusly:locale'.
 *  4. Re-mounting the form (simulating a refresh) re-reads localStorage
 *     and stays in Spanish.
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Login } from './Login'
import { initI18n } from '../i18n'

describe('<Login /> + LocaleSwitcher (browser smoke)', () => {
  it('renders English labels by default', async () => {
    render(<Login onAuthenticated={() => undefined} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByText('Email')).toBeInTheDocument()
    expect(screen.getByText('Password')).toBeInTheDocument()
    expect(screen.getByText('Continue with SSO')).toBeInTheDocument()
  })

  it('uses the accessible primary text token in dark mode', async () => {
    document.documentElement.dataset.theme = 'dark'
    try {
      render(<Login onAuthenticated={() => undefined} />)
      const toggle = await screen.findByRole('button', { name: 'Need an account? Sign up' })
      expect(getComputedStyle(toggle).color).toBe('rgb(122, 162, 255)')
    } finally {
      delete document.documentElement.dataset.theme
    }
  })

  it('switches to Spanish in real time when the corner switcher fires', async () => {
    render(<Login onAuthenticated={() => undefined} />)

    const select = await screen.findByLabelText(/change language|cambiar idioma/i)
    fireEvent.change(select, { target: { value: 'es' } })

    expect(await screen.findByText('Bienvenido de nuevo')).toBeInTheDocument()
    expect(screen.getByText('Correo electrónico')).toBeInTheDocument()
    expect(screen.getByText('Contraseña')).toBeInTheDocument()
    expect(screen.getByText('Continuar con SSO')).toBeInTheDocument()
  })

  it("persists the choice to localStorage['janusly:locale']", async () => {
    render(<Login onAuthenticated={() => undefined} />)
    const select = await screen.findByLabelText(/change language|cambiar idioma/i)
    fireEvent.change(select, { target: { value: 'es' } })

    await waitFor(() => {
      expect(window.localStorage.getItem('janusly:locale')).toBe('es')
    })
  })

  it('survives a simulated refresh (initI18n re-read of storage)', async () => {
    // First render — pick Spanish + verify persisted.
    const { unmount } = render(<Login onAuthenticated={() => undefined} />)
    const select = await screen.findByLabelText(/change language|cambiar idioma/i)
    fireEvent.change(select, { target: { value: 'es' } })
    await waitFor(() => {
      expect(window.localStorage.getItem('janusly:locale')).toBe('es')
    })
    unmount()

    // Simulate refresh — this is what `main.tsx` does at boot.
    const stored = window.localStorage.getItem('janusly:locale')
    expect(stored).toBe('es')
    initI18n('es')

    render(<Login onAuthenticated={() => undefined} />)
    expect(await screen.findByText('Bienvenido de nuevo')).toBeInTheDocument()
  })
})
