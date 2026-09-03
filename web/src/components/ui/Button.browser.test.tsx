import { userEvent } from 'vitest/browser'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

function rgb(value: string): [number, number, number] {
  const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Expected an RGB color, received ${value}`)
  return channels as [number, number, number]
}

function luminance(value: string): number {
  const convert = (channel: number) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = rgb(value).map(convert)
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)]
    .sort((left, right) => right - left)
  return (lighter! + 0.05) / (darker! + 0.05)
}

describe('<Button /> contrast (browser)', () => {
  it('keeps primary hover copy WCAG AA in the dark theme', async () => {
    render(
      <div data-theme="dark">
        <Button variant="primary">Add connection</Button>
      </div>,
    )
    const button = screen.getByRole('button', { name: 'Add connection' })

    await userEvent.hover(button)
    const styles = getComputedStyle(button)
    expect(contrast(styles.color, styles.backgroundColor)).toBeGreaterThanOrEqual(4.5)
  })
})
