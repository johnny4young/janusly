import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { initI18n } from '../i18n'
import { QueueLagChip } from './QueueLagChip'

describe('<QueueLagChip /> (browser smoke)', () => {
  it('renders clear, processing, delayed, and unavailable states in both locales', () => {
    const { rerender } = render(
      <QueueLagChip
        health={{ waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 60 }}
        checkedAt={Date.parse('2026-07-15T12:00:00Z')}
      />,
    )
    const chip = screen.getByTestId('queue-lag-chip')
    expect(chip).toHaveAttribute('data-state', 'clear')
    expect(chip).toHaveTextContent('Workflow queue clear')
    expect(chip.getBoundingClientRect().height).toBeGreaterThan(0)

    rerender(<QueueLagChip health={{ waiting: 2, active: 1, oldestWaitingSeconds: 40, warnSeconds: 60 }} />)
    expect(chip).toHaveAttribute('data-state', 'processing')
    expect(chip).toHaveTextContent('2 jobs waiting · oldest 40 seconds')
    const processingBorder = getComputedStyle(chip).borderColor

    rerender(<QueueLagChip health={{ waiting: 2, active: 1, oldestWaitingSeconds: 125, warnSeconds: 60 }} />)
    expect(chip).toHaveAttribute('data-state', 'delayed')
    expect(chip).toHaveTextContent('Queue delayed')
    expect(chip).toHaveTextContent('Jobs are still processing')
    expect(getComputedStyle(chip).borderColor).not.toBe(processingBorder)

    rerender(<QueueLagChip health={{ waiting: 2, active: 0, oldestWaitingSeconds: 125, warnSeconds: 60 }} />)
    expect(chip).toHaveTextContent('Jobs are waiting for a worker')

    rerender(<QueueLagChip health={null} />)
    expect(chip).toHaveAttribute('data-state', 'unavailable')
    expect(chip).toHaveTextContent('Queue status unavailable')

    initI18n('es')
    rerender(<QueueLagChip health={{ waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 60 }} />)
    expect(chip).toHaveAttribute('data-state', 'clear')
    expect(chip).toHaveTextContent('Cola de flujos sin espera')

    rerender(<QueueLagChip health={{ waiting: 2, active: 1, oldestWaitingSeconds: 40, warnSeconds: 60 }} />)
    expect(chip).toHaveAttribute('data-state', 'processing')
    expect(chip).toHaveTextContent('2 trabajos en espera · el más antiguo lleva 40 segundos')

    rerender(<QueueLagChip health={{ waiting: 2, active: 1, oldestWaitingSeconds: 125, warnSeconds: 60 }} />)
    expect(chip).toHaveAttribute('data-state', 'delayed')
    expect(chip).toHaveTextContent('Cola con demora')
    expect(chip).toHaveTextContent('Los trabajos siguen en proceso')

    rerender(<QueueLagChip health={{ waiting: 2, active: 0, oldestWaitingSeconds: 125, warnSeconds: 60 }} />)
    expect(chip).toHaveTextContent('Los trabajos están esperando un proceso de ejecución')

    rerender(<QueueLagChip health={null} />)
    expect(chip).toHaveTextContent('Estado de la cola no disponible')
  })

  it('renders the isolated maintenance signal in both locales', () => {
    const { rerender } = render(
      <QueueLagChip
        kind="maintenance"
        health={{ waiting: 2, active: 0, oldestWaitingSeconds: 301, warnSeconds: 300 }}
      />,
    )
    const chip = screen.getByTestId('maintenance-queue-lag-chip')
    expect(chip).toHaveAttribute('data-state', 'delayed')
    expect(chip).toHaveTextContent('Maintenance delayed')

    initI18n('es')
    rerender(
      <QueueLagChip
        kind="maintenance"
        health={{ waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 300 }}
      />,
    )
    expect(chip).toHaveAttribute('data-state', 'clear')
    expect(chip).toHaveTextContent('Cola de mantenimiento sin espera')
  })
})
