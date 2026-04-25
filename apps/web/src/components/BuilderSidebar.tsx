import React from 'react'
import { nodeTypes } from '../constants'

export function BuilderSidebar({ onAdd, onValidate, onSave, onLoad, onStart }: any) {
  return (
    <div style={{ padding: 12 }}>
      <h3>Builder</h3>
      {nodeTypes.map(t => (
        <button key={t} onClick={() => onAdd(t)} style={{ display: 'block', width: '100%', marginBottom: 6 }}>{t.toUpperCase()}</button>
      ))}
      <hr />
      <button onClick={onValidate}>Validate</button>
      <button onClick={onSave}>Save</button>
      <button onClick={onLoad}>Load</button>
      <button onClick={onStart}>Start</button>
    </div>
  )
}
