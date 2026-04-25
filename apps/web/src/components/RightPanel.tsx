import React from 'react'
import { CrewTimeline } from '../CrewTimeline'

export function RightPanel({ tab, events }: any) {
  if (tab === 'crew') return <CrewTimeline events={events} />
  return <div style={{ padding: 10 }}>Select a tab</div>
}
