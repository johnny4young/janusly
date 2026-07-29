import { Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { writeNodePaletteDrag } from '../canvas-node-drag'
import { getNodeHelper, getNodeLabel, nodeTypes } from '../constants'
import { useT } from '../i18n'

const STEP_GROUPS: readonly { id: string; labelKey: string; types: readonly string[] }[] = [
  { id: 'ai', labelKey: 'sidebar.category.ai', types: ['ai', 'agent', 'multi_agent', 'agent_reflection'] },
  { id: 'flow', labelKey: 'sidebar.category.flow', types: ['condition', 'router', 'router_llm', 'loop', 'parallel_fork', 'join'] },
  { id: 'human', labelKey: 'sidebar.category.human', types: ['approval', 'human_form'] },
  { id: 'tools', labelKey: 'sidebar.category.tools', types: ['tool', 'http', 'webhook', 'mcp_tool', 'subworkflow', 'pagerduty_incident'] },
  { id: 'triggers', labelKey: 'sidebar.category.triggers', types: ['schedule', 'webhook_received', 'email_received', 'file_dropped', 'mcp_server_event'] },
  { id: 'misc', labelKey: 'sidebar.category.misc', types: ['noop', 'transform', 'wait_until'] },
]

export function CanvasStepPicker({
  onAddNode,
}: {
  onAddNode: (type: string, position?: { x: number; y: number }) => void
}) {
  const { t } = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const groups = useMemo(() => {
    const known = new Set(nodeTypes)
    return STEP_GROUPS.map((group) => ({
      ...group,
      types: group.types.filter((type) => {
        if (!known.has(type)) return false
        if (!normalizedQuery) return true
        return `${getNodeLabel(type)} ${getNodeHelper(type)} ${type}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      }),
    })).filter((group) => group.types.length > 0)
  }, [normalizedQuery])

  const add = (type: string) => {
    onAddNode(type)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="canvas-step-picker" ref={rootRef}>
      <button
        type="button"
        className="small-command canvas-step-picker__trigger"
        aria-expanded={open}
        aria-controls="canvas-step-picker-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={14} aria-hidden="true" />
        <span>{t('canvas.addStep')}</span>
      </button>
      {open && (
        <section
          id="canvas-step-picker-menu"
          className="canvas-step-picker__menu"
          role="dialog"
          aria-label={t('canvas.stepPicker.title')}
          data-dragging={dragging ? 'true' : 'false'}
        >
          <div className="canvas-step-picker__head">
            <div>
              <strong>{t('canvas.stepPicker.title')}</strong>
              <small>{t('canvas.stepPicker.body')}</small>
            </div>
            <button
              type="button"
              className="small-command"
              onClick={() => setOpen(false)}
              aria-label={t('canvas.stepPicker.close')}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <label className="we-panel-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('canvas.stepPicker.search')}
              aria-label={t('canvas.stepPicker.search')}
            />
          </label>
          <div className="canvas-step-picker__groups">
            {groups.map((group) => (
              <section className="canvas-step-picker__group" key={group.id}>
                <span>{t(group.labelKey as never)}</span>
                <div>
                  {group.types.map((type) => (
                    <button
                      key={type}
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        writeNodePaletteDrag(event.dataTransfer, type)
                        setDragging(true)
                      }}
                      onDragEnd={() => {
                        setDragging(false)
                        setOpen(false)
                        setQuery('')
                      }}
                      onClick={() => add(type)}
                    >
                      <strong>{getNodeLabel(type)}</strong>
                      <small>{getNodeHelper(type)}</small>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {groups.length === 0 && (
              <p className="canvas-step-picker__empty">{t('canvas.stepPicker.empty')}</p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
