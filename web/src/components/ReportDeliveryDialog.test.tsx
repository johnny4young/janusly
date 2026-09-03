import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { ReportDeliveryDialog } from './ReportDeliveryDialog'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const bumpPlatformVersion = vi.fn()
const addToast = vi.fn()

vi.mock('../store', () => ({
  useWorkflowStore: (selector: (state: { bumpPlatformVersion: () => void; addToast: typeof addToast }) => unknown) =>
    selector({ bumpPlatformVersion, addToast }),
}))

const sourceRun = {
  id: 'src-run-id',
  status: 'failed',
  workflowName: 'Billing flow',
}

describe('<ReportDeliveryDialog />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    bumpPlatformVersion.mockReset()
    addToast.mockReset()
  })

  it('renders idle state with the three destinations and source-run summary', () => {
    render(<ReportDeliveryDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Send run report/i })).toBeInTheDocument()
    expect(screen.getByText('src-run-id')).toBeInTheDocument()
    expect(screen.getByText('Billing flow')).toBeInTheDocument()
    expect(screen.getByTestId('report-delivery-destination-slack')).toBeInTheDocument()
    expect(screen.getByTestId('report-delivery-destination-github')).toBeInTheDocument()
    expect(screen.getByTestId('report-delivery-destination-webhook')).toBeInTheDocument()
    // Submit disabled until credential name is filled.
    expect(screen.getByTestId('report-delivery-submit')).toBeDisabled()
  })

  it('enables submit once a slack credential name is provided', () => {
    render(<ReportDeliveryDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('report-delivery-credential'), { target: { value: 'ops-channel' } })
    expect(screen.getByTestId('report-delivery-submit')).toBeEnabled()
  })

  it('requires owner + repo before github submit is enabled', () => {
    render(<ReportDeliveryDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('report-delivery-destination-github'))
    fireEvent.change(screen.getByTestId('report-delivery-credential'), { target: { value: 'bot-github' } })
    expect(screen.getByTestId('report-delivery-submit')).toBeDisabled()
    fireEvent.change(screen.getByTestId('report-delivery-owner'), { target: { value: 'janusly' } })
    expect(screen.getByTestId('report-delivery-submit')).toBeDisabled()
    fireEvent.change(screen.getByTestId('report-delivery-repo'), { target: { value: 'demo' } })
    expect(screen.getByTestId('report-delivery-submit')).toBeEnabled()
  })

  it('requires url before webhook submit is enabled', () => {
    render(<ReportDeliveryDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('report-delivery-destination-webhook'))
    fireEvent.change(screen.getByTestId('report-delivery-credential'), { target: { value: 'partner' } })
    expect(screen.getByTestId('report-delivery-submit')).toBeDisabled()
    fireEvent.change(screen.getByTestId('report-delivery-url'), { target: { value: 'https://partner.example.com/hooks' } })
    expect(screen.getByTestId('report-delivery-submit')).toBeEnabled()
  })

  it('flags a malformed webhook URL inline and keeps submit disabled', () => {
    render(<ReportDeliveryDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('report-delivery-destination-webhook'))
    fireEvent.change(screen.getByTestId('report-delivery-credential'), { target: { value: 'partner' } })
    const url = screen.getByTestId('report-delivery-url')

    fireEvent.change(url, { target: { value: 'not-a-url' } })
    expect(screen.getByText(/valid http\(s\) URL/i)).toBeInTheDocument()
    expect(url).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('report-delivery-submit')).toBeDisabled()

    fireEvent.change(url, { target: { value: 'https://partner.example.com/hooks' } })
    expect(screen.queryByText(/valid http\(s\) URL/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('report-delivery-submit')).toBeEnabled()
  })

  it('POSTs the slack delivery body and surfaces the success message', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, destination: 'slack', statusCode: 200, latencyMs: 12 })

    render(<ReportDeliveryDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('report-delivery-credential'), { target: { value: 'ops-channel' } })
    fireEvent.click(screen.getByTestId('report-delivery-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('report-delivery-close-done')).toBeInTheDocument()
    })

    expect(api).toHaveBeenCalledWith('/reports/run-explain/deliver', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"kind":"slack"'),
    }))
    expect(addToast).toHaveBeenCalledWith('Run explain report sent to slack', 'success')
    expect(bumpPlatformVersion).toHaveBeenCalled()
  })

  it('surfaces a failure envelope and exposes a Retry CTA', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: false, error: 'credential secret missing for ops-channel', latencyMs: 1 })

    render(<ReportDeliveryDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('report-delivery-credential'), { target: { value: 'ops-channel' } })
    fireEvent.click(screen.getByTestId('report-delivery-submit'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/credential secret missing/i)
    })
    expect(screen.getByTestId('report-delivery-retry')).toBeInTheDocument()
    // bumpPlatformVersion should NOT fire on the failure path.
    expect(bumpPlatformVersion).not.toHaveBeenCalled()
  })

  it('passes parsed labels through when the operator fills the comma-separated list', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, destination: 'github', statusCode: 201, deliveryId: 'https://github.com/janusly/demo/issues/7' })

    render(<ReportDeliveryDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('report-delivery-destination-github'))
    fireEvent.change(screen.getByTestId('report-delivery-credential'), { target: { value: 'bot-github' } })
    fireEvent.change(screen.getByTestId('report-delivery-owner'), { target: { value: 'janusly' } })
    fireEvent.change(screen.getByTestId('report-delivery-repo'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByTestId('report-delivery-labels'), { target: { value: 'incident, run-explain ,  ' } })
    fireEvent.click(screen.getByTestId('report-delivery-submit'))

    await waitFor(() => {
      expect(screen.getByTestId('report-delivery-result-link')).toBeInTheDocument()
    })

    const [, init] = vi.mocked(api).mock.calls[0]!
    const parsed = JSON.parse((init?.body as string) ?? '{}')
    expect(parsed.destination.labels).toEqual(['incident', 'run-explain'])
  })
})
