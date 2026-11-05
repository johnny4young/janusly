import { useEffect, useState } from 'react'

import { api } from '../api'
import { CredentialCreateDialog, type CreateCredential } from './CredentialCreateDialog'

/** The create dialog for one credential a solution pack requires, opened from the pack's checklist. */
export function PackConnectDialog({ packId, credential, onCreate, onClose }: {
  packId: string
  credential: { name: string; kind: string }
  onCreate: CreateCredential
  onClose: () => void
}) {
  const [managedStorageAvailable, setManagedStorageAvailable] = useState(true)

  useEffect(() => {
    let cancelled = false
    api('/credentials/health')
      .then((response) => {
        if (!cancelled) setManagedStorageAvailable((response as { managedStorageAvailable?: boolean } | null)?.managedStorageAvailable === true)
      })
      .catch(() => {
        if (!cancelled) setManagedStorageAvailable(false)
      })
    return () => { cancelled = true }
  }, [])

  // A connected row loses its button, so the dialog has no opener to return focus to.
  useEffect(() => () => {
    if (document.activeElement !== document.body) return
    document.querySelector(`[data-testid="solution-pack-${packId}"]`)
      ?.querySelector<HTMLElement>('[data-testid^="pack-connect-"], [data-testid^="pack-install-"]')?.focus()
  }, [packId])

  return (
    <CredentialCreateDialog
      preset={credential}
      onClose={onClose}
      onCreate={onCreate}
      managedStorageAvailable={managedStorageAvailable}
    />
  )
}
