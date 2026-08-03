import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText } from './clipboard'

const originalClipboard = navigator.clipboard
const originalExecCommand = document.execCommand

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand })
  document.querySelectorAll('textarea[aria-hidden="true"]').forEach((node) => {
    node.remove()
  })
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('uses the Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await expect(copyText('incident summary')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('incident summary')
  })

  it('falls back to a selected textarea when Clipboard API is unavailable', async () => {
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const selectionSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'setSelectionRange')
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    await expect(copyText('fallback summary')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(selectionSpy).toHaveBeenCalledWith(0, 'fallback summary'.length)
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('tries the textarea fallback after a Clipboard API rejection', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    })

    await expect(copyText('retry')).resolves.toBe(true)
  })

  it('cleans up and restores focus when textarea selection throws', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementationOnce(() => {
      throw new Error('selection blocked')
    })

    await expect(copyText('protected fallback')).resolves.toBe(false)
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })
})
