import { AlertCircle, LockKeyhole, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useT } from '../i18n'
import { Button } from './ui/Button'
import { FieldStack, FormField } from './ui/Form'

const CREDENTIAL_ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/

const CREDENTIAL_KINDS = [
  'generic',
  'github_token',
  'slack_webhook',
  'slack_signing_secret',
  'webhook_secret',
  'postgres',
  'pagerduty_api_token',
  'pagerduty_webhook_secret',
  'external_runtime_signing_secret',
] as const

export type CreateCredential = (credential: {
  name: string
  kind: string
  secretValue?: string
  secretRef?: string
  expiresAt?: string
}) => Promise<boolean>

export function CredentialCreateDialog({
  onClose,
  onCreate,
  managedStorageAvailable,
  preset,
}: {
  onClose: () => void
  onCreate: CreateCredential
  managedStorageAvailable: boolean
  /** Locks name and kind: a required credential only counts when both match. */
  preset?: { name: string; kind: string }
}) {
  const { t } = useT()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const secretInputRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState(preset?.name ?? '')
  const [kind, setKind] = useState(preset?.kind ?? 'generic')
  const [storage, setStorage] = useState<'managed' | 'environment'>('managed')
  const [secretValue, setSecretValue] = useState('')
  const [secretRef, setSecretRef] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  useDialogFocusTrap(dialogRef, { initialFocus: preset ? secretInputRef : nameRef, onEscape: submitting ? undefined : onClose })

  useEffect(() => {
    if (managedStorageAvailable || storage !== 'managed') return
    // A late health response may arrive after the dialog opened. Move away
    // from the unavailable path and erase a value that can no longer submit.
    setStorage('environment')
    setSecretValue('')
  }, [managedStorageAvailable, storage])

  const trimmedRef = secretRef.trim()
  const refInvalid = trimmedRef.length > 0 && !CREDENTIAL_ENV_VAR_NAME.test(trimmedRef)
  const canSubmit = name.trim().length > 0
    && (storage === 'managed' ? secretValue.length > 0 : CREDENTIAL_ENV_VAR_NAME.test(trimmedRef))

  const submit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      const created = await onCreate({
        name: name.trim(),
        kind,
        ...(storage === 'managed' ? { secretValue } : { secretRef: trimmedRef }),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      })
      if (created) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="run-input-backdrop" onClick={() => { if (!submitting) onClose() }}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credential-create-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true"><LockKeyhole size={18} /></span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{t('rightPanel.credentials.formKicker')}</div>
            <h2 id="credential-create-title">{t('rightPanel.credentials.formTitle')}</h2>
            <p className="helper-text">{t('rightPanel.credentials.valuePlaceholder')}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label={t('common.close')}
            disabled={submitting}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="run-input-dialog__body">
            <FieldStack disabled={submitting} labelledBy="credential-create-title">
              <FormField
                id="credential-name"
                label={t('rightPanel.credentials.nameLabel')}
                required
              >
                {(controlProps) => (
                  <input
                    {...controlProps}
                    ref={nameRef}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="off"
                    disabled={Boolean(preset)}
                    required
                  />
                )}
              </FormField>
              <FormField id="credential-kind" label={t('rightPanel.credentials.kindLabel')}>
                {(controlProps) => (
                  <select
                    {...controlProps}
                    value={kind}
                    disabled={Boolean(preset)}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    {(preset ? [preset.kind] : CREDENTIAL_KINDS).map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                )}
              </FormField>
              <FormField
                id="credential-storage"
                label={t('rightPanel.credentials.storageLabel')}
                hint={!managedStorageAvailable
                  ? t('rightPanel.credentials.storage.managedUnavailableHint')
                  : undefined}
              >
                {(controlProps) => (
                  <select
                    {...controlProps}
                    value={storage}
                    onChange={(event) => setStorage(event.target.value as 'managed' | 'environment')}
                  >
                    <option value="managed" disabled={!managedStorageAvailable}>
                      {managedStorageAvailable
                        ? t('rightPanel.credentials.storage.managed')
                        : t('rightPanel.credentials.storage.managedUnavailable')}
                    </option>
                    <option value="environment">{t('rightPanel.credentials.storage.environment')}</option>
                  </select>
                )}
              </FormField>
              <FormField
                id="credential-secret"
                label={storage === 'managed'
                  ? t('rightPanel.credentials.valueLabel')
                  : t('rightPanel.credentials.envLabel')}
                required
                hint={storage === 'managed' ? t('credentialRotation.field.newSecretValueHelp') : undefined}
                error={storage === 'environment' && refInvalid ? (
                  <><AlertCircle size={13} aria-hidden="true" /> {t('rightPanel.credentials.envInvalid')}</>
                ) : undefined}
              >
                {(controlProps) => storage === 'managed' ? (
                  <input
                    {...controlProps}
                    ref={secretInputRef}
                    type="password"
                    autoComplete="new-password"
                    value={secretValue}
                    onChange={(event) => setSecretValue(event.target.value)}
                    placeholder={t('rightPanel.credentials.valuePlaceholder')}
                    required
                  />
                ) : (
                  <input
                    {...controlProps}
                    ref={secretInputRef}
                    value={secretRef}
                    onChange={(event) => setSecretRef(event.target.value)}
                    placeholder={t('rightPanel.credentials.envPlaceholder')}
                    required
                  />
                )}
              </FormField>
              <FormField
                id="credential-expiry"
                label={t('rightPanel.credentials.expiryLabel')}
                hint={t('rightPanel.credentials.expiryHint')}
              >
                {(controlProps) => (
                  <input
                    {...controlProps}
                    type="date"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                )}
              </FormField>
            </FieldStack>
          </div>

          <footer className="run-input-dialog__footer">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!canSubmit || submitting}
              loading={submitting}
              loadingLabel={t('common.working')}
              leadingIcon={<Plus size={15} />}
            >
              {t('rightPanel.credentials.addButton')}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  )
}
