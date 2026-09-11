import { useT } from '../i18n'
import type { ValidationEvidenceLevel } from '../types'

const TONES: Record<ValidationEvidenceLevel | 'unknown', string> = {
  unknown: 'warning',
  static: 'neutral',
  writes_skipped: 'warning',
  provider_simulated: 'info',
  live_canary: 'primary',
}

export function ValidationEvidencePill({
  level,
  tone,
  testId,
}: {
  level: ValidationEvidenceLevel | null | undefined
  tone?: string
  testId?: string
}) {
  const { t } = useT()
  const evidenceLevel = level ?? 'unknown'
  return (
    <span
      className="we-pill"
      data-tone={tone ?? TONES[evidenceLevel]}
      data-testid={testId}
      title={t(`validationEvidence.${evidenceLevel}.description`)}
    >
      {t(`validationEvidence.${evidenceLevel}`)}
    </span>
  )
}
