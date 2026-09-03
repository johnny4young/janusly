import { CredentialRotateModal } from '@janusly/web'
import { Stage } from './_stage'

/**
 * Rotates a stored credential. Only the credential's name is passed in — the
 * secret itself is never handed to the client, which is why there is no value
 * prop and no way to read the old one back.
 */

/** Rotating a provider API key. */
export function ApiKey() {
  return (
    <Stage>
      <CredentialRotateModal credentialName="acme-billing-api" onClose={() => {}} />
    </Stage>
  )
}

/** A longer credential name, to check the header wraps rather than clips. */
export function LongName() {
  return (
    <Stage>
      <CredentialRotateModal
        credentialName="acme-billing-reconciliation-service-account"
        onClose={() => {}}
      />
    </Stage>
  )
}
