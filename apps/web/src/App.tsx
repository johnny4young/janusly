import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Layout } from './Layout'
import { BuilderSidebar } from './components/BuilderSidebar'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { RightPanel } from './components/RightPanel'
import { Login } from './components/Login'
import { UserMenu } from './components/UserMenu'
import { AuthProvider, isSupabaseConfigured, normalizeAuth } from './auth'
import { useWorkflowStore } from './store'
import { api } from './api'
import { statusStyles } from './constants'
import type { Credential, RunEvent, RunNode, RunSummary, Template, ToolSchema, ValidationIssue, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'

// ... (rest unchanged above)

  const replayNode = useCallback(async (nodeId: string) => {
    if (!runId) return

    try {
      await api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId }),
      })

      await loadStatus(runId)
      addToast(`Node ${nodeId} replayed`, 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Replay failed', 'error')
    }
  }, [addToast, loadStatus, runId])

// ... (later in JSX)

      panel={
        <RightPanel
          tab={activeTab}
          events={events}
          runNodes={runNodes}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          validationIssues={validationIssues}
          tools={tools}
          templates={templates}
          credentials={credentials}
          runs={runs}
          usage={usage}
          onOpenWorkflow={openWorkflow}
          onUseTemplate={(workflow) => {
            hydrateWorkflow(workflow)
            setValidationIssues([])
            setActiveTab('inspector')
          }}
          onInstallPlugin={installPlugin}
          onCreateCredential={createCredential}
          onOpenRun={openRun}
          onRefreshPlatform={refreshPlatform}
          onUpdateNodeConfig={updateSelectedNodeConfig}
          onUpdateNodeType={updateSelectedNodeType}
          onUpdateEdgeCondition={updateEdgeCondition}
          onApproveNode={approveNode}
          onReplayNode={replayNode}
        />
      }
