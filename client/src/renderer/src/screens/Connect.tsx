import { useState, type FormEvent } from 'react'
import { Api, loadLast, login, normalizeServerUrl, saveSession } from '../lib/api'
import { presetServer } from '../lib/config'
import { useStore } from '../store'

export function Connect() {
  const last = loadLast()
  const [serverUrl, setServerUrl] = useState(last.serverUrl || '')
  const [nickname, setNickname] = useState(last.nickname)
  const [password, setPassword] = useState('')
  const [error, setError] = useState(() => useStore.getState().notice ?? '')
  const [loading, setLoading] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    useStore.setState({ notice: null })
    setLoading(true)
    try {
      const session = presetServer
        ? await login(presetServer.serverUrl, presetServer.password, nickname.trim())
        : await login(normalizeServerUrl(serverUrl), password, nickname.trim())
      saveSession(session)
      useStore.setState({ session, api: new Api(session) })
    } catch (err) {
      const status = (err as { status?: number }).status
      setError(
        presetServer && status === 401
          ? 'A senha embutida neste app está desatualizada. Peça o instalador novo.'
          : (err as Error).message,
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="connect">
      <form className="connect-card" onSubmit={submit}>
        <h1>Resenha</h1>
        <p className="muted">
          {presetServer ? 'Como a galera vai te chamar?' : 'Entre no servidor da galera'}
        </p>

        {!presetServer && (
          <>
            <label className="field">
              <span>Endereço do servidor</span>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="ex: 203-0-113-5.sslip.io ou localhost:3000"
                required
                autoFocus={!last.serverUrl}
              />
            </label>
            <label className="field">
              <span>Senha do servidor</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus={!!last.serverUrl}
              />
            </label>
          </>
        )}
        <label className="field">
          <span>Seu apelido</span>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={32}
            required
            autoFocus={!!presetServer}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn primary big" disabled={loading}>
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}
