/**
 * Command palette — Cmd+K (or Ctrl+K) opens a searchable list of every
 * navigation tab + frequent action (Save / Validate / Run / Toggle theme /
 * Sign out / configured Docs capability). Mirrors Linear / Raycast / Cursor's palette UX.
 *
 * Used by `App.tsx` (mounted in the `overlay` slot, controlled by
 * `paletteOpen` state). The topbar ⌘K button calls `onOpen()` to surface
 * the same UI; keyboard shortcut is bound globally on the document.
 *
 * Persists recently-used commands to `localStorage["janusly:palette:recent"]`
 * so the next open surfaces them at the top.
 *
 * A sentence about runs switches to run search: `lib/run-query.ts` parses it and
 * `CommandPaletteRuns.tsx` shows the chips and pages `/runs`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import {
  Activity,
  BarChart3,
  Boxes,
  CheckCircle2,
  Compass,
  Gauge,
  GitBranch,
  Home,
  KeyRound,
  Layers,
  Layers3,
  LogOut,
  Moon,
  Play,
  PlayCircle,
  RefreshCcw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  SquarePlus,
  Sun,
  Users,
  Workflow,
} from 'lucide-react'
import type { ActiveTab } from '../types'
import { useT } from '../i18n'
import { applyTheme, type ThemePreference } from '../theme'
import { openDocsUrl, parseDocsUrl } from '../docs-link'
import { rankPaletteMatches } from '../command-palette-search'
import { formatStatusLabel } from '../constants'
import { parseRunQuery } from '../lib/run-query'
import type { RunSummary } from '../types'
import { PaletteRunFilters, formatRunTime, runRequestFor, usePaletteRunResults } from './CommandPaletteRuns'
import './CommandPalette.css'
import {
  WORKSPACE_DESTINATION_DEFINITIONS,
  resolveWorkspaceDestinationTarget,
  type WorkspaceDestination,
} from '../workspace-locations'

const STORAGE_KEY = 'janusly:palette:recent'
const RECENT_LIMIT = 4
const COMMAND_LISTBOX_ID = 'janusly-command-palette-options'

function commandOptionId(index: number): string {
  return `janusly-command-palette-option-${index}`
}

type CommandId = string

type Command = {
  id: CommandId
  labelKey: string
  hintKey?: string
  icon: React.ReactNode
  /** Display section grouping: nav (view jump) / action (do thing) / system (theme, sign out). */
  group: 'nav' | 'action' | 'system'
  shortcut?: string
  /** Effective tenant permission required to expose this command. */
  permission?: string
  run: (ctx: CommandContext) => void
}

type CommandContext = {
  openTab: (tab: ActiveTab) => void
  onValidate: () => void
  onSave: () => void
  onStart: () => void
  onNew: () => void
  onSignOut: () => void
  onInsertSnippet: () => void
}

export type PaletteWorkflow = { id: string; name: string }
export type PaletteRecipe = { id: string; name: string }

export type CommandPaletteProps = CommandContext & {
  open: boolean
  onClose: () => void
  /** Validated build-time docs capability; absent means no Docs command. */
  docsUrl?: string | null
  /** Dynamic results: saved workflows the operator can open directly. */
  workflows?: PaletteWorkflow[]
  /** Dynamic results: recipes the operator can browse. */
  recipes?: PaletteRecipe[]
  /** Called when the operator picks a saved workflow from the palette. */
  onOpenWorkflow?: (id: string) => void
  /** Called when the operator picks a recipe from the palette. */
  onOpenRecipe?: (id: string) => void
  /** Effective permissions from the selected organization. */
  permissions?: readonly string[]
  /** Opens one run in Activity (read only). */
  onOpenRun?: (runId: string) => void
  /** Open dead letters by run; Retry hands off to the queue, which owns the write. */
  recoveryTargets?: ReadonlyArray<{ id: string; runId: string }>
  onOpenRecovery?: (deadLetterId: string) => void
}

type RunEntry =
  | { kind: 'run'; run: RunSummary }
  | { kind: 'replay'; run: RunSummary; deadLetterId: string }
  | { kind: 'more' }

function readRecent(): CommandId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function persistRecent(ids: CommandId[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // private mode etc.
  }
}

const DESTINATION_COMMAND_ICONS: Record<WorkspaceDestination, React.ReactNode> = {
  home: <Home size={14} />,
  workflows: <Workflow size={14} />,
  activity: <Activity size={14} />,
  settings: <Gauge size={14} />,
}

function buildCommands(
  docsUrl: string | null | undefined,
  permissions?: readonly string[],
): Command[] {
  const destinationCommands = WORKSPACE_DESTINATION_DEFINITIONS.flatMap<Command>((destination) => {
    const target = resolveWorkspaceDestinationTarget(destination.id, permissions)
    if (!target) return []
    return [{
      id: `go.destination.${destination.id}`,
      labelKey: `palette.destination.${destination.id}`,
      icon: DESTINATION_COMMAND_ICONS[destination.id],
      group: 'nav',
      shortcut: destination.shortcut,
      run: ({ openTab }) => { openTab(target) },
    }]
  })

  const navCommands: Command[] = [
    { id: 'go.recover', labelKey: 'palette.nav.recover', icon: <ShieldAlert size={14} />, group: 'nav', permission: 'recovery.read', run: ({ openTab }) => { openTab('recover') } },
    { id: 'go.ai-studio', labelKey: 'palette.nav.ai-studio', icon: <Sparkles size={14} />, group: 'nav', permission: 'ai.write', run: ({ openTab }) => { openTab('ai-studio') } },
    { id: 'go.inspector', labelKey: 'palette.nav.inspector', icon: <GitBranch size={14} />, group: 'nav', permission: 'workflows.read', run: ({ openTab }) => { openTab('inspector') } },
    { id: 'go.runs', labelKey: 'palette.nav.runs', icon: <Activity size={14} />, group: 'nav', permission: 'runs.read', run: ({ openTab }) => { openTab('runs') } },
    { id: 'go.multiAgent', labelKey: 'palette.nav.multiAgent', icon: <Layers3 size={14} />, group: 'nav', permission: 'workflows.read', run: ({ openTab }) => { openTab('multiAgent') } },
    { id: 'go.reports', labelKey: 'palette.nav.reports', icon: <BarChart3 size={14} />, group: 'nav', permission: 'recovery.read', run: ({ openTab }) => { openTab('reports') } },
    { id: 'go.members', labelKey: 'palette.nav.members', icon: <Users size={14} />, group: 'nav', permission: 'members.read', run: ({ openTab }) => { openTab('members') } },
    { id: 'go.templates', labelKey: 'palette.nav.templates', icon: <Workflow size={14} />, group: 'nav', permission: 'workflows.read', run: ({ openTab }) => { openTab('templates') } },
    { id: 'go.marketplace', labelKey: 'palette.nav.marketplace', icon: <Boxes size={14} />, group: 'nav', permission: 'workflows.read', run: ({ openTab }) => { openTab('marketplace') } },
    { id: 'go.credentials', labelKey: 'palette.nav.credentials', icon: <KeyRound size={14} />, group: 'nav', permission: 'credentials.read', run: ({ openTab }) => { openTab('credentials') } },
  ]

  const actionCommands: Command[] = [
    { id: 'action.new', labelKey: 'palette.action.new', icon: <SquarePlus size={14} />, group: 'action', permission: 'workflows.write', run: ({ onNew }) => { onNew() } },
    { id: 'action.validate', labelKey: 'palette.action.validate', icon: <CheckCircle2 size={14} />, group: 'action', permission: 'workflows.write', run: ({ onValidate }) => { onValidate() } },
    { id: 'action.save', labelKey: 'palette.action.save', icon: <Save size={14} />, group: 'action', permission: 'workflows.write', run: ({ onSave }) => { onSave() } },
    { id: 'action.run', labelKey: 'palette.action.run', icon: <Play size={14} />, group: 'action', permission: 'runs.start', run: ({ onStart }) => { onStart() } },
    { id: 'action.insertSnippet', labelKey: 'palette.action.insertSnippet', icon: <Layers size={14} />, group: 'action', permission: 'workflows.write', run: ({ onInsertSnippet }) => { onInsertSnippet() } },
    { id: 'action.recover', labelKey: 'palette.action.recover', icon: <ShieldAlert size={14} />, group: 'action', permission: 'recovery.read', run: ({ openTab }) => { openTab('recover') } },
    { id: 'action.openRuns', labelKey: 'palette.action.openRuns', icon: <PlayCircle size={14} />, group: 'action', permission: 'runs.read', run: ({ openTab }) => { openTab('runs') } },
    { id: 'action.openRecipes', labelKey: 'palette.action.openRecipes', icon: <Compass size={14} />, group: 'action', permission: 'workflows.read', run: ({ openTab }) => { openTab('templates') } },
  ]

  const systemCommands: Command[] = [
    {
      id: 'system.theme.light',
      labelKey: 'palette.system.themeLight',
      icon: <Sun size={14} />,
      group: 'system',
      run: () => { applyTheme('light' as ThemePreference); try { localStorage.setItem('janusly:theme', 'light') } catch {} },
    },
    {
      id: 'system.theme.dark',
      labelKey: 'palette.system.themeDark',
      icon: <Moon size={14} />,
      group: 'system',
      run: () => { applyTheme('dark' as ThemePreference); try { localStorage.setItem('janusly:theme', 'dark') } catch {} },
    },
    ...(docsUrl ? [{
      id: 'system.docs',
      labelKey: 'palette.system.docs',
      icon: <Search size={14} />,
      group: 'system' as const,
      run: () => { openDocsUrl(docsUrl) },
    }] : []),
    { id: 'system.signOut', labelKey: 'palette.system.signOut', icon: <LogOut size={14} />, group: 'system', run: ({ onSignOut }) => { onSignOut() } },
  ]

  return [...destinationCommands, ...navCommands, ...actionCommands, ...systemCommands]
}

const GROUP_KEY_LABELS: Record<Command['group'] | 'dynamic', string> = {
  nav: 'palette.group.nav',
  action: 'palette.group.action',
  system: 'palette.group.system',
  dynamic: 'palette.group.open',
}

export function CommandPalette({
  open,
  onClose,
  openTab,
  onValidate,
  onSave,
  onStart,
  onNew,
  onSignOut,
  onInsertSnippet,
  docsUrl = null,
  workflows = [],
  recipes = [],
  onOpenWorkflow,
  onOpenRecipe,
  permissions,
  onOpenRun,
  recoveryTargets = [],
  onOpenRecovery,
}: CommandPaletteProps) {
  const { t } = useT()
  const safeDocsUrl = parseDocsUrl(docsUrl)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [recent, setRecent] = useState<CommandId[]>(() => readRecent())
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // Always-mounted (renders null while closed) → drive the trap off `open`.
  useDialogFocusTrap(dialogRef, { active: open })
  const can = (permission: string) => permissions === undefined || permissions.includes(permission)
  const [now, setNow] = useState(() => new Date())
  const parsedRuns = useMemo(() => parseRunQuery(query, workflows), [query, workflows])
  const runMode = parsedRuns.isRunQuery && can('runs.read') && Boolean(onOpenRun)
  const runResults = usePaletteRunResults(runMode ? runRequestFor(parsedRuns, now) : null)
  const canReplay = can('dlq.replay') && can('dlq.read') && Boolean(onOpenRecovery)
  const runEntries = useMemo<RunEntry[]>(() => {
    const entries = runResults.runs.flatMap<RunEntry>(run => {
      const target = canReplay ? recoveryTargets.find(item => item.runId === run.id) : undefined
      return target ? [{ kind: 'run', run }, { kind: 'replay', run, deadLetterId: target.id }] : [{ kind: 'run', run }]
    })
    return runResults.next ? [...entries, { kind: 'more' }] : entries
  }, [canReplay, recoveryTargets, runResults.next, runResults.runs])

  const commands = useMemo<Command[]>(() => {
    const base = buildCommands(safeDocsUrl, permissions)
    const dynamicCommands: Command[] = [
      ...workflows.slice(0, 20).map<Command>((wf) => ({
        id: `workflow.${wf.id}`,
        labelKey: 'palette.dynamic.openWorkflow',
        icon: <Workflow size={14} />,
        group: 'nav',
        permission: 'workflows.read',
        run: ({ openTab: jump }) => {
          if (onOpenWorkflow) onOpenWorkflow(wf.id); else jump('workflows')
        },
      })),
      ...recipes.slice(0, 20).map<Command>((rc) => ({
        id: `recipe.${rc.id}`,
        labelKey: 'palette.dynamic.openRecipe',
        icon: <Compass size={14} />,
        group: 'nav',
        permission: 'workflows.read',
        run: ({ openTab: jump }) => {
          if (onOpenRecipe) onOpenRecipe(rc.id); else jump('templates')
        },
      })),
    ]
    // Replace label resolution: dynamic items show their own name verbatim
    // rather than a translation key. We attach the name via a closure on
    // a separate map below.
    const all = [...base, ...dynamicCommands]
    return permissions === undefined
      ? all
      : all.filter((command) => !command.permission || permissions.includes(command.permission))
  }, [safeDocsUrl, workflows, recipes, onOpenWorkflow, onOpenRecipe, permissions])

  // Map of dynamic display labels keyed by command id — keeps the
  // translation table untouched while letting the palette show real names.
  const dynamicLabels = useMemo(() => {
    const map = new Map<string, string>()
    for (const wf of workflows) map.set(`workflow.${wf.id}`, wf.name)
    for (const rc of recipes) map.set(`recipe.${rc.id}`, rc.name)
    return map
  }, [workflows, recipes])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setNow(new Date())
    setRecent(readRecent())
    const focus = () => inputRef.current?.focus()
    // Defer focus until the input has mounted.
    const id = window.requestAnimationFrame(focus)
    return () => window.cancelAnimationFrame(id)
  }, [open])

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

  const labelFor = useCallback(
    (cmd: Command): string => dynamicLabels.get(cmd.id) ?? (t(cmd.labelKey)),
    [dynamicLabels, t],
  )

  const ordered = useMemo<Command[]>(() => {
    const byId = new Map(commands.map(cmd => [cmd.id, cmd]))
    const recentEntries = recent.map(id => byId.get(id)).filter((cmd): cmd is Command => Boolean(cmd))
    const rest = commands.filter(cmd => !recent.includes(cmd.id))
    const all = [...recentEntries, ...rest]
    return rankPaletteMatches(
      query,
      all.map((cmd) => ({ item: cmd, label: labelFor(cmd), keywords: [cmd.id] })),
    )
  }, [commands, labelFor, query, recent])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const entryCount = runMode ? runEntries.length : ordered.length
  useEffect(() => {
    setActiveIndex(idx => Math.min(idx, Math.max(0, entryCount - 1)))
  }, [entryCount])

  const runCommand = (cmd: Command) => {
    const ctx: CommandContext = { openTab, onValidate, onSave, onStart, onNew, onSignOut, onInsertSnippet }
    cmd.run(ctx)
    const nextRecent = [cmd.id, ...recent.filter(id => id !== cmd.id)].slice(0, RECENT_LIMIT)
    setRecent(nextRecent)
    persistRecent(nextRecent)
    onClose()
  }

  const runEntry = (entry: RunEntry) => {
    if (entry.kind === 'more') {
      runResults.loadMore()
      return
    }
    if (entry.kind === 'run') onOpenRun?.(entry.run.id)
    else onOpenRecovery?.(entry.deadLetterId)
    onClose()
  }
  const activate = (index: number) => {
    if (runMode) {
      const entry = runEntries[index]
      if (entry) runEntry(entry)
      return
    }
    const cmd = ordered[index]
    if (cmd) runCommand(cmd)
  }

  if (!open) return null

  return (
    <div
      ref={dialogRef}
      className="we-cmdk-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('palette.title')}
      data-testid="command-palette"
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
            role="combobox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex(idx => Math.min(idx + 1, entryCount - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex(idx => Math.max(idx - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                activate(activeIndex)
              }
            }}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            aria-autocomplete="list"
            aria-controls={COMMAND_LISTBOX_ID}
            aria-expanded="true"
            aria-activedescendant={activeIndex < entryCount ? commandOptionId(activeIndex) : undefined}
          />
          <kbd>{t('palette.key.escape')}</kbd>
        </div>
        {runMode && (
          <PaletteRunFilters
            query={query}
            parsed={parsedRuns}
            workflows={workflows}
            now={now}
            onQueryChange={(next, removed) => {
              setQuery(next)
              if (removed) inputRef.current?.focus()
            }}
          />
        )}

        <ul
          ref={listRef}
          id={COMMAND_LISTBOX_ID}
          className="we-cmdk-list"
          role="listbox"
          aria-label={t('palette.title')}
        >
          {runMode && runEntries.length === 0 && (
            <li className="we-cmdk-empty" role="presentation" data-testid="palette-runs-state">
              {t(runResults.kind === 'error' ? 'palette.runs.error' : runResults.loading ? 'palette.runs.loading' : 'palette.runs.empty')}
            </li>
          )}
          {runMode && runEntries.map((entry, idx) => {
            const label = entry.kind === 'more'
              ? t('palette.runs.more')
              : entry.kind === 'replay'
                ? t('palette.runs.replay', { id: entry.run.id.slice(0, 8) })
                : entry.run.workflowName || workflows.find(item => item.id === entry.run.workflowId)?.name || entry.run.workflowId || entry.run.id
            return (
              <li
                key={entry.kind === 'more' ? 'more' : `${entry.kind}.${entry.run.id}`}
                id={commandOptionId(idx)}
                role="option"
                aria-selected={idx === activeIndex}
                aria-disabled={entry.kind === 'more' && runResults.loading ? true : undefined}
                className={idx === activeIndex ? 'we-cmdk-row we-cmdk-row--active' : 'we-cmdk-row'}
                data-testid={entry.kind === 'more' ? 'palette-runs-more' : `palette-${entry.kind}-${entry.run.id}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(event) => { event.preventDefault(); runEntry(entry) }}
              >
                <span className="we-cmdk-row__ic" aria-hidden="true">
                  {entry.kind === 'replay' ? <RefreshCcw size={14} /> : <PlayCircle size={14} />}
                </span>
                <span className="we-cmdk-row__label">
                  {label}
                  {entry.kind === 'run' && <code className="we-cmdk-row__id">{entry.run.id.slice(0, 8)}…</code>}
                </span>
                {entry.kind === 'run' && <span className="status-pill" data-status={entry.run.status}>{formatStatusLabel(entry.run.status)}</span>}
                <span className="we-cmdk-row__group">
                  {entry.kind === 'run'
                    ? entry.run.createdAt && formatRunTime(Date.parse(entry.run.createdAt))
                    : entry.kind === 'replay' ? t('palette.group.action') : null}
                </span>
              </li>
            )
          })}
          {!runMode && ordered.length === 0 && (
            <li className="we-cmdk-empty" role="presentation">{t('palette.empty', { query })}</li>
          )}
          {!runMode && ordered.map((cmd, idx) => {
            const isRecent = recent.includes(cmd.id) && !query.trim()
            return (
              <li
                key={cmd.id}
                id={commandOptionId(idx)}
                role="option"
                aria-selected={idx === activeIndex}
                title={cmd.hintKey ? (t(cmd.hintKey)) : labelFor(cmd)}
                className={idx === activeIndex ? 'we-cmdk-row we-cmdk-row--active' : 'we-cmdk-row'}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(event) => { event.preventDefault(); runCommand(cmd) }}
              >
                <span className="we-cmdk-row__ic" aria-hidden="true">{cmd.icon}</span>
                <span className="we-cmdk-row__label">{labelFor(cmd)}</span>
                {isRecent ? (
                  <span className="we-cmdk-row__pill">{t('palette.recentTag')}</span>
                ) : (
                  <span className="we-cmdk-row__group">{t(GROUP_KEY_LABELS[dynamicLabels.has(cmd.id) ? 'dynamic' : cmd.group])}</span>
                )}
                {cmd.shortcut ? <kbd className="we-cmdk-row__kbd">{cmd.shortcut}</kbd> : null}
              </li>
            )
          })}
        </ul>

        <footer className="we-cmdk-footer">
          <span><kbd>{t('palette.key.up')}</kbd> <kbd>{t('palette.key.down')}</kbd> {t('palette.footer.navigate')}</span>
          <span><kbd>{t('palette.key.enter')}</kbd> {t('palette.footer.run')}</span>
          <span><kbd>{t('palette.key.escape')}</kbd> {t('palette.footer.close')}</span>
        </footer>
      </div>
    </div>
  )
}
