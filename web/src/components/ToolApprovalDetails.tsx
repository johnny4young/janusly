import { useT } from '../i18n'
import type { ToolApprovalRequest } from '../run-observability'

/** The exact call a person decides on: its parameters, hidden values and decision rules. */
export function ToolApprovalDetails({ nodeId, request }: { nodeId: string; request: ToolApprovalRequest }) {
  const { t } = useT()
  return (
    <div className="we-run-overview__payload">
      <strong>{t('rightPanel.runs.toolApproval.params')}</strong>
      <pre className="code-field" data-testid={`tool-approval-params-${nodeId}`}>
        {JSON.stringify(request.params, null, 2)}
      </pre>
      {request.maskedPaths.length > 0 && (
        <p className="helper-text" data-testid={`tool-approval-masked-${nodeId}`}>
          {t('rightPanel.runs.toolApproval.masked', { paths: request.maskedPaths.join(', ') })}
        </p>
      )}
      <dl className="we-run-overview__facts" data-testid={`tool-approval-policy-${nodeId}`}>
        <div>
          <dt>{t('rightPanel.runs.toolApproval.approvers')}</dt>
          <dd>{request.requiredApprovals}</dd>
        </div>
        <div>
          <dt>{t('rightPanel.runs.toolApproval.selfApproval')}</dt>
          <dd>{t('rightPanel.runs.toolApproval.selfApprovalOff')}</dd>
        </div>
        <div>
          <dt>{t('rightPanel.runs.toolApproval.onDeny')}</dt>
          <dd>{t('rightPanel.runs.toolApproval.onDenyValue')}</dd>
        </div>
        <div>
          <dt>{t('rightPanel.runs.toolApproval.onTimeout')}</dt>
          <dd>{t('rightPanel.runs.toolApproval.onTimeoutValue')}</dd>
        </div>
      </dl>
    </div>
  )
}
