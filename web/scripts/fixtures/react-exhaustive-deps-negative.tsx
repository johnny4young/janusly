import { useEffect } from 'react'

export function MissingEffectDependency({ value }: { value: string }) {
  useEffect(() => {
    document.title = value
  }, [])

  return null
}
