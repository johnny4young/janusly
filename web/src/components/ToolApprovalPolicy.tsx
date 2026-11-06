import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { sessionCan } from '../identity-context'
import { orgConfigValue } from '../lib/org-config-model'
import { useWorkflowStore } from '../store'
import { SwitchField } from './ui/SwitchField'

const POLICY_KEY = 'tools.approvalRequired'

function listedTools(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map(name => name.trim()).filter(Boolean) : []
}

/** The workspace rule that makes every call of a tool wait for a person. */
export function ToolApprovalPolicy({ tool }: { tool: string }) {
  const { t } = useT()
  const canEdit = useWorkflowStore(state => sessionCan(state.identityContext, 'org.config.write'))
  const addToast = useWorkflowStore(state => state.addToast)
  const [listed, setListed] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Resolve through a promise so a caller that stubs api() still renders.
    Promise.resolve(api('/org/config'))
      .then(payload => { if (!cancelled) setListed(listedTools(orgConfigValue(payload, POLICY_KEY))) })
      .catch(() => { if (!cancelled) setListed([]) })
    return () => { cancelled = true }
  }, [])

  if (listed === null) return null
  const required = listed.includes(tool)
  if (!canEdit) {
    return required
      ? <span className="we-pill" data-tone="warning" data-testid="tool-approval-policy">{t('rightPanel.quickConfig.toolApprovalPolicy')}</span>
      : null
  }
  return (
    <SwitchField
      checked={required}
      disabled={saving}
      label={t('rightPanel.quickConfig.toolApprovalPolicySwitch')}
      data-testid="tool-approval-policy-switch"
      onChange={async event => {
        setSaving(true)
        try {
          // The server adds or removes this one tool, so a stale list never overwrites another admin's change.
          const result = await api('/org/tool-approval-policy', { method: 'POST', body: JSON.stringify({ tool, required: event.target.checked }) })
          const tools = (result as { tools?: unknown } | undefined)?.tools
          setListed(Array.isArray(tools) ? tools.filter((name): name is string => typeof name === 'string') : listed)
        } catch (error) {
          addToast(error instanceof Error ? error.message : t('rightPanel.quickConfig.toolApprovalPolicyFailed'), 'error')
        } finally {
          setSaving(false)
        }
      }}
    />
  )
}
