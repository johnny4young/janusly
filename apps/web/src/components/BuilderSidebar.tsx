import React from 'react'
import { nodeTypes } from '../constants'

export function BuilderSidebar({ onAdd, onValidate, onSave, onOpenDashboard, onNew, onStart, workflowName }: any) {
  return (
    <div style={{ padding: 12 }}>
      <h3>Builder</h3>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>{workflowName}</div>

      {nodeTypes.map(t => (
        <button key={t} onClick={() => onAdd(t)} style={{ display: 'block', width: '100%', marginBottom: 6 }}>{t.toUpperCase()}</button>
      ))}

      <hr />
      <button onClick={onNew} style={{ width: '100%', marginBottom: 6 }}>New workflow</button>
      <button onClick={onOpenDashboard} style={{ width: '100%', marginBottom: 6 }}>Workflows</button>
      <button onClick={onValidate} style={{ width: '100%', marginBottom: 6 }}>Validate</button>
      <button onClick={onSave} style={{ width: '100%', marginBottom: 6 }}>Save</button>
      <button onClick={onStart} style={{ width: '100%', marginBottom: 6 }}>Start</button>
    </div>
  )
}
