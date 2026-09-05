import { useT } from '../i18n'
import type { ValidationEvidenceLevel } from '../types'

const LABEL_KEYS: Record<ValidationEvidenceLevel, string> = {
  static: 'validationEvidence.static',
  writes_skipped: 'validationEvidence.writes_skipped',
  provider_simulated: 'validationEvidence.provider_simulated',
  live_canary: 'validationEvidence.live_canary',
}

const TONES: Record<ValidationEvidenceLevel, string> = {
  static: 'neutral',
  writes_skipped: 'warning',
  provider_simulated: 'success',
  live_canary: 'primary',
}

export function ValidationEvidencePill({
  level,
  tone,
  testId,
}: {
  level: ValidationEvidenceLevel
  tone?: string
  testId?: string
}) {
  const { t } = useT()
  return (
    <span
      className="we-pill"
      data-tone={tone ?? TONES[level]}
      data-testid={testId}
    >
      {t(LABEL_KEYS[level])}
    </span>
  )
}
