
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Activity } from 'lucide-react'
import { VitalSignsStrip } from './VitalSignsStrip'

describe('<VitalSignsStrip /> (browser smoke)', () => {
  it('announces custom clickable labels with severity in real Chromium', () => {
    render(
      <VitalSignsStrip
        tiles={[
          {
            icon: <Activity />,
            label: 'Failures',
            display: '5',
            severity: 'unhealthy',
            severityLabel: 'Critical',
            ariaLabel: 'Open failed runs in Recovery Center',
            onClick: vi.fn(),
            testId: 'tile-failures',
          },
        ]}
      />,
    )

    expect(screen.getByTestId('tile-failures')).toHaveAccessibleName('Open failed runs in Recovery Center, Critical')
  })
})
