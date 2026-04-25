import React from 'react'
import { ToastRenderer } from './components/ToastRenderer'

export function Layout({ sidebar, main, panel, header }: {
  sidebar: React.ReactNode
  main: React.ReactNode
  panel: React.ReactNode
  header?: React.ReactNode
}) {
  return (
    <div style={{ height: '100vh', display: 'grid', gridTemplateRows: header ? '48px 1fr' : '1fr' }}>
      {header && (
        <div style={{ borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', padding: '0 12px', background: 'white' }}>
          {header}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr 420px', background: '#f1f5f9' }}>
        <div style={{ borderRight: '1px solid #e5e7eb', overflow: 'auto' }}>
          {sidebar}
        </div>

        <div style={{ position: 'relative' }}>
          {main}
        </div>

        <div style={{ borderLeft: '1px solid #e5e7eb', overflow: 'auto', background: '#f8fafc' }}>
          {panel}
        </div>
      </div>

      <ToastRenderer />
    </div>
  )
}
