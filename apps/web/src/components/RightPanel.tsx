import React, { useMemo, useState } from 'react'
import type { WorkflowGraphEdge, WorkflowGraphNode, ActiveTab, Credential, RunEvent, RunNode, RunSummary, Template, ToolSchema, ValidationIssue, WorkflowDefinition } from '../types'
import { CrewTimeline } from '../CrewTimeline'
import { WorkflowsDashboard } from './WorkflowsDashboard'
import { MembersPanel } from './MembersPanel'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { RunExplainChat } from './RunExplainChat'
import { nodeTypes } from '../constants'

// ... rest unchanged ...

  if (props.tab === 'runs') return (
    <RunsPanel
      runs={props.runs}
      usage={props.usage}
      runNodes={props.runNodes}
      onOpenRun={props.onOpenRun}
      onRefreshPlatform={props.onRefreshPlatform}
      onApproveNode={props.onApproveNode}
      onReplayNode={props.onReplayNode}
    >
      <RunExplainChat runId={props.runs?.[0]?.id ?? null} />
    </RunsPanel>
  )

// ... rest unchanged ...
