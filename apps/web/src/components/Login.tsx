import React, { useState } from 'react'
import { AuthProvider } from '../auth'

export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    const fn = mode === 'login' ? AuthProvider.signIn : AuthProvider.signUp
    const { error } = await fn(email, password)
    if (error) return setError(error.message)
    onAuthenticated()
  }

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9' }}>
      <div style={{ background: 'white', padding: 20, borderRadius: 12, width: 320 }}>
        <h2>{mode === 'login' ? 'Login' : 'Sign Up'}</h2>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email" style={{ width: '100%', marginBottom: 8 }} />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="password" style={{ width: '100%', marginBottom: 8 }} />
        {error && <div style={{ color: 'red', fontSize: 12 }}>{error}</div>}
        <button onClick={submit} style={{ width: '100%' }}>{mode}</button>
        <button onClick={() => setMode(mode === 'login' ? 'signup' : 'login')} style={{ marginTop: 6 }}>
          switch to {mode === 'login' ? 'signup' : 'login'}
        </button>
      </div>
    </div>
  )
}
