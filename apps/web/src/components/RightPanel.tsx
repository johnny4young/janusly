import React from 'react'
import { CrewTimeline } from '../CrewTimeline'
import { WorkflowsDashboard } from './WorkflowsDashboard'

export function RightPanel({ tab, events, onOpenWorkflow }: any) {
  if (tab === 'crew') return <CrewTimeline events={events} />
  if (tab === 'workflows') return <WorkflowsDashboard onOpen={onOpenWorkflow} />
  return <div style={{ padding: 10 }}>Select a tab</div>
}
