import { useState } from 'react'

export function ConditionalHook({ enabled }: { enabled: boolean }) {
  if (enabled) {
    useState(0)
  }
  return null
}
