import { lazy, Suspense, useRef, useState, type FormEvent } from 'react'
import { Sparkles } from 'lucide-react'
import { useT } from '../../i18n'
import { useWorkflowStore } from '../../store'
import { Button } from '../ui/Button'
import type { HomeOperatorPanelProps, OperatorRequest } from './HomeOperatorPanel'
import './recovery-center.css'

const HomeOperatorPanel = lazy(() => import('./HomeOperatorPanel').then((module) => ({
  default: module.HomeOperatorPanel,
})))

export function HomeOperatorField(props: Omit<HomeOperatorPanelProps, 'request' | 'onAsk' | 'onClose'>) {
  const { t } = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState<OperatorRequest | null>(null)

  const close = () => {
    setOpen(false)
    setRequest(null)
    inputRef.current?.focus()
  }

  const ask = (next: OperatorRequest) => {
    setRequest(next)
    setOpen(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const question = value.trim()
    if (!question) return
    // A loaded draft is what the operator has always answered about; Home usually has none.
    const hasDraft = useWorkflowStore.getState().nodes.length > 0
    ask({ question, runId: hasDraft ? undefined : props.openFailures[0]?.runId })
    setValue('')
    inputRef.current?.focus()
  }

  return (
    <>
      <form
        className="we-home-operator"
        onSubmit={submit}
        onKeyDown={(event) => { if (event.key === 'Escape' && open) close() }}
        data-testid="home-operator-field"
      >
        <Sparkles size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('recoveryCenter.composer.placeholder')}
          aria-label={t('recoveryCenter.composer.placeholder')}
          data-testid="home-operator-input"
        />
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => { if (open) close(); else setOpen(true) }}
          data-testid="home-operator-suggestions"
        >
          {t('home.operator.suggestions')}
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!value.trim()} data-testid="home-operator-ask">
          {t('home.operator.ask')}
        </Button>
      </form>
      {open && (
        <Suspense fallback={null}>
          <HomeOperatorPanel {...props} request={request} onAsk={ask} onClose={close} />
        </Suspense>
      )}
    </>
  )
}
