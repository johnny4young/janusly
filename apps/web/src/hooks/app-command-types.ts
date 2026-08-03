import type { Dispatch, SetStateAction } from 'react'
import type { Translate } from '../i18n/resources'
import type {
  AiReviewIssue,
  RunSummary,
  ValidationIssue,
} from '../types'
import type { BootstrapData } from './useBootstrapData'
import type { useAppStore } from './useAppStore'
import type { usePlatformMutation } from './usePlatformMutation'
import type { createRunTransitionGuard } from '../run-transition'

export type AppStore = ReturnType<typeof useAppStore>
export type PlatformMutation = ReturnType<typeof usePlatformMutation>
export type RunTransitionGuard = ReturnType<typeof createRunTransitionGuard>

export type AppCommandsOptions = {
  store: AppStore
  permissions: readonly string[]
  projectedRuns: RunSummary[]
  refreshPlatform: BootstrapData['refreshPlatform']
  projectRunSummary: (id: string, patch: Partial<RunSummary>) => void
  loadStatus: (runId: string) => Promise<unknown>
  runTransitionGuard: RunTransitionGuard
  runPlatformMutation: PlatformMutation
  setValidationIssues: Dispatch<SetStateAction<ValidationIssue[]>>
  setAiReviewIssues: Dispatch<SetStateAction<AiReviewIssue[]>>
  setCurrentWorkflowVersion: Dispatch<SetStateAction<number | null>>
  setRunInputOpen: Dispatch<SetStateAction<boolean>>
  setRunInputServerErrors: Dispatch<SetStateAction<string[]>>
  setRunInputSubmitting: Dispatch<SetStateAction<boolean>>
  setActivityRecoveryId: Dispatch<SetStateAction<string | null>>
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>
  focusSidebarSearch: () => boolean
  t: Translate
}
