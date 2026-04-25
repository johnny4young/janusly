import React from 'react'
import { CrewTimeline } from '../CrewTimeline'
import { WorkflowsDashboard } from './WorkflowsDashboard'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { MembersPanel } from './MembersPanel'

export function RightPanel({ tab, events, onOpenWorkflow }: any) {
  if (tab === 'crew') return <CrewTimeline events={events} />
  if (tab === 'workflows') return <WorkflowsDashboard onOpen={onOpenWorkflow} />
  if (tab === 'inspector') return <VersionHistoryPanel />
  if (tab === 'members') return <MembersPanel />
  return <div style={{ padding: 10 }}>Select a tab</div>
}
