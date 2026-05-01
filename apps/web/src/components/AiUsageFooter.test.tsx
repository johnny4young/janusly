import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AiUsageFooter } from './RightPanel'

describe('AiUsageFooter (ENG-012 per-node usage surfacing)', () => {
  it('renders nothing when stateJson is null', () => {
    const { container } = render(<AiUsageFooter stateJson={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when stateJson lacks an usage field (non-AI node)', () => {
    const { container } = render(
      <AiUsageFooter stateJson={{ status: 'completed', value: 'hello' }} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the full footer when usage + costUsd + latencyMs are present', () => {
    render(
      <AiUsageFooter
        stateJson={{
          model: 'gpt-4o-mini',
          provider: 'openai',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          costUsd: 0.000045,
          latencyMs: 1234,
        }}
      />,
    )
    const footer = screen.getByTestId('ai-usage-footer')
    expect(footer).toBeTruthy()
    expect(footer.textContent).toContain('gpt-4o-mini (openai)')
    expect(footer.textContent).toContain('150 tokens')
    expect(footer.textContent).toContain('$0.000045')
    expect(footer.textContent).toContain('1234ms')
  })

  it('reads usage from the persisted stateJson.output wrapper', () => {
    render(
      <AiUsageFooter
        stateJson={{
          output: {
            model: 'gpt-4o-mini',
            provider: 'openai',
            usage: { totalTokens: 75 },
            costUsd: 0.000022,
            latencyMs: 640,
          },
        }}
      />,
    )
    const footer = screen.getByTestId('ai-usage-footer')
    expect(footer.textContent).toContain('gpt-4o-mini (openai)')
    expect(footer.textContent).toContain('75 tokens')
    expect(footer.textContent).toContain('$0.000022')
    expect(footer.textContent).toContain('640ms')
  })

  it('falls back to input/output split when totalTokens is missing', () => {
    render(
      <AiUsageFooter
        stateJson={{
          model: 'claude-haiku-4-5',
          usage: { inputTokens: 80, outputTokens: 30 },
        }}
      />,
    )
    expect(screen.getByTestId('ai-usage-footer').textContent).toContain('80/30 tokens')
  })

  it('omits costUsd when null and latency when undefined', () => {
    render(
      <AiUsageFooter
        stateJson={{
          model: 'gpt-future',
          usage: { totalTokens: 10 },
          costUsd: null,
        }}
      />,
    )
    const footer = screen.getByTestId('ai-usage-footer')
    expect(footer.textContent).toContain('10 tokens')
    expect(footer.textContent).not.toMatch(/\$/)
    expect(footer.textContent).not.toMatch(/ms/)
  })
})
