import { expect, test, type Page } from '@playwright/test'
import { execPostgresSql } from './_helpers/postgres'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'

type Member = 'creator' | 'decider'

/** Opens Activity > Publish requests as one member: every browser call carries their id. */
async function openAs(page: Page, orgId: string, userId: string, requestId?: string) {
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
  }, orgId)
  await page.route('**/*', async (route) => {
    const headers = route.request().headers()
    if (!headers['x-user-id']) return route.continue()
    return route.continue({ headers: { ...headers, 'x-user-id': userId } })
  })
  await page.goto(requestId ? `/#/publishRequests/${requestId}` : '/#/publishRequests')
  await expect(page.getByTestId('publish-requests-panel')).toBeVisible({ timeout: 30_000 })
}

/** What workflows.publish leaves behind when a draft needs a person: the
 *  agent's draft, its passed receipt and a pending request. */
async function seedRequest(orgId: string, agent: string, onBehalfOf: string, name: string, options: { expired?: boolean } = {}) {
  const suffix = `${name}-${Math.random().toString(36).slice(2, 8)}`
  const workflowId = `wf-${suffix}`
  const digest = suffix.padEnd(64, '0').slice(0, 64)
  const document = JSON.stringify({
    id: workflowId, name: `Refunds ${name}`, dslVersion: '1.0',
    nodes: [
      { id: 'shape', type: 'transform', config: { mapping: { ok: 'true' } } },
      { id: 'notify', type: 'http', config: { url: 'https://hooks.example.com/refunds', method: 'POST',
        headers: { Authorization: 'Bearer {{secret.refunds_token}}' } } },
    ],
    edges: [{ from: 'shape', to: 'notify' }],
  }).replaceAll("'", "''")
  await execPostgresSql(`
    INSERT INTO workflow_drafts (id, org_id, workflow_id, document, digest, created_by)
      VALUES ('draft-${suffix}', '${orgId}', '${workflowId}', '${document}'::jsonb, '${digest}', '${agent}');
    INSERT INTO draft_qualifications (id, org_id, draft_id, digest, status, checks, fixture_runs, created_by, completed_at)
      VALUES ('qual-${suffix}', '${orgId}', 'draft-${suffix}', '${digest}', 'passed',
        '[{"code":"static","status":"passed","message":"structure, readiness, contracts, credentials and literals passed"}]',
        '[{"fixture":"happy path","runId":"run-${suffix}","status":"passed"}]', '${agent}', now());
    INSERT INTO publish_requests (id, org_id, workflow_id, draft_id, qualification_id, reasons, requested_by, on_behalf_of, drafted_by, expires_at)
      VALUES ('pub-${suffix}', '${orgId}', '${workflowId}', 'draft-${suffix}', 'qual-${suffix}', '{first_publish,outbound}',
        '${agent}', '${onBehalfOf}', '${agent}', now() + interval '${options.expired ? '-1 minute' : '1 day'}');`)
  return { requestId: `pub-${suffix}`, workflowId, draftId: `draft-${suffix}` }
}

test.describe('agent publish requests', () => {
  let orgId: string
  let member: Record<Member, string>
  let agent: string
  const headers = (who: string) => ({ 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': who, 'x-janusly-csrf': '1' })

  test.beforeEach(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    orgId = `publish-requests-${stamp}`
    member = { creator: `pr-creator-${stamp}`, decider: `pr-decider-${stamp}` }
    agent = `agent:pr-agent-${stamp}`
    await execPostgresSql(`
      INSERT INTO org_members (id, org_id, user_id, role) VALUES
        ('m-${member.creator}', '${orgId}', '${member.creator}', 'editor'),
        ('m-${member.decider}', '${orgId}', '${member.decider}', 'editor');
      INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
        VALUES ('pr-agent-${stamp}', '${orgId}', 'Claude Code', ARRAY['read','propose','test','publish'],
          sha256(convert_to('pr-agent-${stamp}', 'UTF8')), 'abcd', '${member.creator}', now() + interval '1 day');`)
  })

  test('an agent opens a request, a person approves it and the version is published', async ({ page, request }) => {
    const seeded = await seedRequest(orgId, agent, member.creator, 'approve')
    await openAs(page, orgId, member.decider)
    const row = page.getByTestId(`publish-request-${seeded.requestId}`)
    await expect(row).toContainText('Claude Code')
    await expect(page.getByTestId('publish-requests-waiting')).toHaveText('1')
    await row.click()

    const detail = page.getByTestId('publish-request-detail')
    await expect(detail.getByTestId('publish-request-effects')).toContainText('hooks.example.com')
    await expect(detail.getByTestId('publish-request-effects')).toContainText('refunds_token')
    await expect(detail.getByTestId('publish-request-reasons')).toContainText('First publish')
    await detail.getByLabel('Reason').fill('Matches the refund policy')
    await detail.getByTestId('publish-request-approve').click()
    await expect(detail.getByTestId('publish-request-status')).toHaveText('Published')
    await expect(detail.getByTestId('publish-request-open-version')).toBeVisible()

    const decided = await (await request.get(`${API_URL}/v1/publish-requests/${seeded.requestId}`, { headers: headers(member.decider) })).json()
    expect(decided.data.request.decisionReason).toBe('Matches the refund policy')
    const latest = await (await request.get(`${API_URL}/v1/workflows/latest?workflowId=${seeded.workflowId}`, { headers: headers(member.decider) })).json()
    expect(latest.data.id).toBe(decided.data.request.publishedVersionId)
  })

  test('with a second person required, the agent creator is blocked and told who decides', async ({ page, request }) => {
    await execPostgresSql(`INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
      VALUES ('cfg-${orgId}', '${orgId}', 'agents.publishRequiresSecondPerson', 'true', 'agents', 'e2e', 'boolean');`)
    const seeded = await seedRequest(orgId, agent, member.creator, 'second')
    await openAs(page, orgId, member.creator, seeded.requestId)
    const detail = page.getByTestId('publish-request-detail')
    await expect(detail.getByTestId('publish-request-refusal')).toContainText('Another member who can edit workflows decides.')
    await expect(detail.getByTestId('publish-request-approve')).toHaveCount(0)
    await expect(page.getByTestId('publish-requests-waiting')).toHaveCount(0)
    const refused = await request.post(`${API_URL}/v1/publish-requests/${seeded.requestId}/approve`, { headers: headers(member.creator), data: {} })
    expect(refused.status()).toBe(403)
    expect((await refused.json()).error.code).toBe('publish_request_second_person')
  })

  test('a qualification that went stale while the person looked is shown, not published', async ({ page }) => {
    const seeded = await seedRequest(orgId, agent, member.creator, 'stale')
    await openAs(page, orgId, member.decider, seeded.requestId)
    const detail = page.getByTestId('publish-request-detail')
    await expect(detail.getByTestId('publish-request-approve')).toBeVisible()
    await execPostgresSql(`UPDATE draft_qualifications SET created_at = now() - interval '25 hours'
      WHERE org_id = '${orgId}' AND draft_id = '${seeded.draftId}';`)
    await detail.getByTestId('publish-request-approve').click()
    await expect(page.getByTestId('publish-request-error')).toContainText('The qualification expired; the agent must qualify the draft again')
    await expect(page.getByTestId('publish-request-refusal')).toContainText('The agent must qualify again.')
    await expect(page.getByTestId('publish-request-approve')).toHaveCount(0)
    await expect(page.getByTestId('publish-request-status')).toHaveText('Pending')
  })

  test('an expired request offers no action', async ({ page }) => {
    const seeded = await seedRequest(orgId, agent, member.creator, 'expired', { expired: true })
    await openAs(page, orgId, member.decider)
    await page.getByTestId('publish-requests-filter-expired').click()
    await page.getByTestId(`publish-request-${seeded.requestId}`).click()
    const detail = page.getByTestId('publish-request-detail')
    await expect(detail.getByTestId('publish-request-status')).toHaveText('Expired')
    await expect(detail).toContainText('Nobody decided it in time.')
    await expect(detail.getByTestId('publish-request-approve')).toHaveCount(0)
    await expect(detail.getByTestId('publish-request-reject')).toHaveCount(0)
  })
})
