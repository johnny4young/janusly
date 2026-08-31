import { describe, expect, it } from 'vitest'

import { streamStatusLabelKey, type StreamStatus } from './AppWorkspace'

describe('streamStatusLabelKey', () => {
  it.each<[StreamStatus, string]>([
    ['idle', 'statusBar.operatorIdle'],
    ['connecting', 'statusBar.operatorConnecting'],
    ['connected', 'statusBar.operatorOnline'],
    ['closed', 'statusBar.operatorOffline'],
    ['error', 'statusBar.operatorOffline'],
  ])('maps %s without describing a resting system as offline', (status, expected) => {
    expect(streamStatusLabelKey(status)).toBe(expected)
  })
})
