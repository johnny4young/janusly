import { useEffect } from 'react'

import { CredentialCreateDialog, type CreateCredential } from './CredentialCreateDialog'

/** The create dialog for one credential a solution pack requires, opened from the pack's checklist. */
export function PackConnectDialog({ packId, credential, onCreate, onClose, managedStorageAvailable }: {
  packId: string
  credential: { name: string; kind: string }
  onCreate: CreateCredential
  onClose: () => void
  managedStorageAvailable: boolean
}) {
  // A connected row loses its button, so the dialog has no opener to return focus to.
  // Install is disabled for a role that connects but can't install; the checklist takes focus then.
  useEffect(() => () => {
    if (document.activeElement !== document.body) return
    const card = document.querySelector(`[data-testid="solution-pack-${packId}"]`)
    const target = card?.querySelector<HTMLElement>('[data-testid^="pack-connect-"], [data-testid^="pack-install-"]:not(:disabled)')
      ?? card?.querySelector<HTMLElement>('section[tabindex]')
    target?.focus()
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
