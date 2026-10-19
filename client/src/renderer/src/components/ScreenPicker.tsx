import { useEffect, useState } from 'react'
import type { ScreenSource } from '../../../preload'
import { QUALITIES, startScreenShare, type ShareOptions, type ShareQuality } from '../lib/voice'
import { Modal } from './Modal'

const PREFS_KEY = 'resenha.share'

function loadPrefs(): ShareOptions {
  const fallback: ShareOptions = { quality: '1080p30', audio: true, hint: 'motion' }
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return fallback
  }
}

export function ScreenPicker({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null)
  const [tab, setTab] = useState<'screens' | 'windows'>('screens')
  const [selected, setSelected] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<ShareOptions>(loadPrefs)

  const refresh = () =>
    window.api.getScreenSources().then((list) => {
      setSources(list)
      setSelected((current) => current ?? list.find((s) => s.isScreen)?.id ?? null)
    })

  useEffect(() => {
    void refresh()
  }, [])

  const visible = (sources ?? []).filter((s) => (tab === 'screens' ? s.isScreen : !s.isScreen))

  const start = (sourceId = selected) => {
    if (!sourceId) return
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    onClose()
    void startScreenShare(sourceId, prefs)
  }

  return (
    <Modal title="Compartilhar tela" onClose={onClose} wide>
      <div className="tabs">
        <button className={tab === 'screens' ? 'active' : ''} onClick={() => setTab('screens')}>
          Telas
        </button>
        <button className={tab === 'windows' ? 'active' : ''} onClick={() => setTab('windows')}>
          Janelas
        </button>
        <button className="link refresh" onClick={refresh}>
          Atualizar
        </button>
      </div>

      <div className="source-grid">
        {sources === null && <p className="muted">Carregando…</p>}
        {visible.map((s) => (
          <button
            key={s.id}
            className={`source${selected === s.id ? ' selected' : ''}`}
            onClick={() => setSelected(s.id)}
            onDoubleClick={() => start(s.id)}
          >
            <img src={s.thumbnail} alt="" />
            <span>
              {s.icon && <img className="source-icon" src={s.icon} alt="" />}
              {s.name}
            </span>
          </button>
        ))}
      </div>

      <div className="share-options">
        <label className="field">
          <span>Qualidade</span>
          <select
            value={prefs.quality}
            onChange={(e) => setPrefs({ ...prefs, quality: e.target.value as ShareQuality })}
          >
            {Object.entries(QUALITIES).map(([key, q]) => (
              <option key={key} value={key}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Otimizar para</span>
          <select
            value={prefs.hint}
            onChange={(e) => setPrefs({ ...prefs, hint: e.target.value as ShareOptions['hint'] })}
          >
            <option value="motion">Jogos e vídeos (fluidez)</option>
            <option value="detail">Texto e código (nitidez)</option>
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={prefs.audio}
            onChange={(e) => setPrefs({ ...prefs, audio: e.target.checked })}
          />
          Compartilhar o áudio do PC
        </label>
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn primary" disabled={!selected} onClick={() => start()}>
          Transmitir
        </button>
      </div>
    </Modal>
  )
}
