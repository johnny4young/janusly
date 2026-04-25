import React from 'react'

export function Layout({ sidebar, main, panel }: {
  sidebar: React.ReactNode
  main: React.ReactNode
  panel: React.ReactNode
}) {
  return (
    <div style={{
      height: '100vh',
      display: 'grid',
      gridTemplateColumns: '240px 1fr 420px',
      background: '#f1f5f9'
    }}>
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
  )
}
