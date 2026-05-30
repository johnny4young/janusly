/**
 * "Insert snippet…" dialog — surfaces the built-in + org-private workflow
 * snippets and inserts the chosen one into the workflow currently being
 * edited as a pure delta.
 *
 * Insertion is fully client-side (`insertSnippet` from `@janusly/shared`):
 * the snippet's nodes get fresh, collision-free ids, the snippet's internal
 * edges are remapped, and — when the operator picks a target node — one
 * stitch edge wires the snippet's entry node onto that target. The new graph
 * is pushed into the Zustand store; the workflow only PERSISTS on the next
 * Save (which audits `workflow.saved`). A best-effort `POST
 * /snippets/:id/inserted` beacon records the `snippet.inserted` audit row.
 *
 * Snippets never run standalone — there's no "run snippet" affordance here.
 *
 * Reuses the `we-cmdk-*` palette CSS tokens so the surface matches the
 * command palette. Mounted from `App.tsx` (controlled by `snippetMenuOpen`).
 *
 * Used by `App.tsx` (Inspector "Insert snippet…" button + Cmd+K palette).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Layers, Search, X } from 'lucide-react'
import {
  BUILTIN_SNIPPET_ID_PREFIX,
  insertSnippet,
  isBuiltinSnippetId,
  type SnippetCategory,
  type SnippetDefinition,
} from '@janusly/shared/src/workflow-snippets'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { getNodeLabel } from '../constants'
import { useT } from '../i18n'

type SnippetInsertMenuProps = {
  open: boolean
  onClose: () => void
}

type SnippetsResponse = { snippets?: SnippetDefinition[] }

/** Map a built-in `builtin:<slug>` id to its i18n copy key suffix. */
function builtinSlug(id: string): string {
  return id.startsWith(BUILTIN_SNIPPET_ID_PREFIX)
    ? id.slice(BUILTIN_SNIPPET_ID_PREFIX.length)
    : id
}

export function SnippetInsertMenu({ open, onClose }: SnippetInsertMenuProps) {
  const { t } = useT()
  const nodes = useWorkflowStore((state) => state.nodes)
  const edges = useWorkflowStore((state) => state.edges)
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId)
  const currentWorkflowId = useWorkflowStore((state) => state.currentWorkflowId)
  const setNodes = useWorkflowStore((state) => state.setNodes)
  const setEdges = useWorkflowStore((state) => state.setEdges)
  const selectNode = useWorkflowStore((state) => state.selectNode)
  const addToast = useWorkflowStore((state) => state.addToast)

  const [snippets, setSnippets] = useState<SnippetDefinition[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  // Default the stitch target to the currently-selected node when there is one.
  const [targetNodeId, setTargetNodeId] = useState<string | null>(selectedNodeId)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Fetch snippets when the dialog opens (built-ins + org custom).
  useEffect(() => {
    if (!open) return
    setQuery('')
    setTargetNodeId(selectedNodeId)
    const id = window.requestAnimationFrame(() => inputRef.current?.focus())
    void (async () => {
      try {
        const res = (await api('/snippets')) as SnippetsResponse
        if (!aliveRef.current) return
        setSnippets(Array.isArray(res.snippets) ? res.snippets : [])
        setLoaded(true)
      } catch {
        if (!aliveRef.current) return
        setSnippets([])
        setLoaded(true)
      }
    })()
    return () => window.cancelAnimationFrame(id)
  }, [open, selectedNodeId])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  /** Resolve the display name (built-ins use i18n; custom use their stored name). */
  const nameFor = (snippet: SnippetDefinition): string =>
    snippet.builtin
      ? (t(`snippets.builtin.${builtinSlug(snippet.id)}.name` as never) as string)
      : snippet.name

  const descriptionFor = (snippet: SnippetDefinition): string =>
    snippet.builtin
      ? (t(`snippets.builtin.${builtinSlug(snippet.id)}.description` as never) as string)
      : snippet.description

  const categoryLabel = (category: SnippetCategory): string =>
    t(`snippets.category.${category}` as never) as string

  const filtered = useMemo<SnippetDefinition[]>(() => {
    const normalised = query.trim().toLowerCase()
    if (!normalised) return snippets
    return snippets.filter((snippet) => {
      const hay = `${nameFor(snippet)} ${descriptionFor(snippet)} ${snippet.tags.join(' ')} ${categoryLabel(snippet.category)}`.toLowerCase()
      return hay.includes(normalised)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippets, query, t])

  if (!open) return null

  const doInsert = (snippet: SnippetDefinition) => {
    // Project the React Flow graph to the minimal workflow shape the pure
    // helper understands, run the delta, then map fresh nodes back onto the
    // canvas (positions are laid out below the existing graph).
    const baseWorkflow = {
      nodes: nodes.map((node) => ({ id: node.id, type: node.data.type, config: node.data.config ?? {} })),
      edges: edges.map((edge) => ({
        from: edge.source,
        to: edge.target,
        ...(edge.data?.condition ? { condition: edge.data.condition } : {}),
      })),
    }
    const result = insertSnippet(baseWorkflow, snippet, targetNodeId)

    const insertedSet = new Set(result.insertedNodeIds)
    const baseY = 160 + nodes.length * 40
    let laneIndex = 0
    const nextNodes: WorkflowGraphNode[] = result.workflow.nodes.map((node) => {
      const existing = nodes.find((n) => n.id === node.id)
      if (existing) return existing
      const position = { x: 120 + (laneIndex % 4) * 230, y: baseY + Math.floor(laneIndex / 4) * 120 }
      laneIndex += 1
      return {
        id: node.id,
        position,
        // Leave `data.label` empty so the canvas resolves it via getNodeLabel.
        data: { label: '', type: node.type, config: node.config ?? {} },
      }
    })

    const existingEdgeKey = new Set(edges.map((edge) => `${edge.source}->${edge.target}`))
    const appendedEdges: WorkflowGraphEdge[] = result.workflow.edges
      .filter((edge) => !existingEdgeKey.has(`${edge.from}->${edge.to}`))
      .map((edge, index) => ({
        id: `snippet-e-${edge.from}-${edge.to}-${index}`,
        source: edge.from,
        target: edge.to,
        label: edge.condition ? 'condition' : undefined,
        animated: Boolean(edge.condition),
        data: { condition: edge.condition },
      }))

    setNodes(nextNodes)
    setEdges([...edges, ...appendedEdges])
    selectNode(result.insertedEntryNodeId)

    addToast(
      t('snippets.toast.inserted', {
        name: nameFor(snippet),
        count: result.insertedNodeIds.length,
      }) as string,
      'success',
    )

    // Best-effort audit beacon — never blocks the insertion.
    void api(`/snippets/${encodeURIComponent(snippet.id)}/inserted`, {
      method: 'POST',
      body: JSON.stringify({ workflowId: currentWorkflowId, insertedNodeCount: insertedSet.size }),
    }).catch(() => undefined)

    onClose()
  }

  return (
    <div
      className="we-cmdk-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('snippets.menu.title')}
      data-testid="snippet-insert-menu"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="we-cmdk-dialog" role="presentation">
        <div className="we-cmdk-input">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('snippets.menu.searchPlaceholder') as string}
            aria-label={t('snippets.menu.searchPlaceholder') as string}
          />
          <button
            type="button"
            className="we-shortcuts-close"
            onClick={onClose}
            aria-label={t('snippets.menu.cancel') as string}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="we-snippet-menu__head">
          <p className="helper-text">{t('snippets.menu.subtitle')}</p>
          <label className="field-label" htmlFor="snippet-target">{t('snippets.menu.targetLabel')}</label>
          <select
            id="snippet-target"
            className="text-field"
            value={targetNodeId ?? ''}
            onChange={(event) => setTargetNodeId(event.target.value || null)}
          >
            <option value="">{t('snippets.menu.targetNone')}</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {getNodeLabel(node.data.type)} · {node.id}
              </option>
            ))}
          </select>
        </div>

        <ul className="we-cmdk-list" role="listbox" aria-label={t('snippets.menu.title')}>
          {loaded && filtered.length === 0 && (
            <li className="we-cmdk-empty" role="presentation">{t('snippets.menu.empty', { query })}</li>
          )}
          {filtered.map((snippet) => (
            <li
              key={snippet.id}
              role="option"
              aria-selected={snippet.id === activeId}
              className={snippet.id === activeId ? 'we-cmdk-row we-cmdk-row--active' : 'we-cmdk-row'}
              data-testid="snippet-row"
              onMouseEnter={() => setActiveId(snippet.id)}
              onMouseDown={(event) => { event.preventDefault(); doInsert(snippet) }}
            >
              <span className="we-cmdk-row__ic" aria-hidden="true"><Layers size={14} /></span>
              <span className="we-cmdk-row__label">
                <span>{nameFor(snippet)}</span>
                <span className="we-snippet-row__desc">{descriptionFor(snippet)}</span>
              </span>
              <span className="we-cmdk-row__group">{categoryLabel(snippet.category)}</span>
              <span className={`we-pill ${snippet.builtin ? 'we-pill--cobalt' : 'we-pill--neutral'}`}>
                {isBuiltinSnippetId(snippet.id)
                  ? t('snippets.menu.builtinBadge')
                  : t('snippets.menu.customBadge')}
              </span>
            </li>
          ))}
        </ul>

        <footer className="we-cmdk-footer">
          <span>
            {filtered.length > 0
              ? t('snippets.menu.nodeCount', { count: filtered.length })
              : null}
          </span>
        </footer>
      </div>
    </div>
  )
}
