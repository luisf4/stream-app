import { MAX_USER_VOLUME, resetUserVolume, setUserVolume } from '../lib/voice'
import { useStore } from '../store'

const MAX_PCT = Math.round(MAX_USER_VOLUME * 100)

/** Volume da voz e da transmissão de uma pessoa (0–200%), salvo neste PC pelo apelido. */
export function UserVolume({ nickname }: { nickname: string }) {
  const volume = useStore((s) => s.settings.volumes[nickname]) ?? { voice: 1, stream: 1 }
  const boosted = volume.voice > 1 || volume.stream > 1
  const changed = volume.voice !== 1 || volume.stream !== 1

  return (
    <div className="menu-volume" onClick={(e) => e.stopPropagation()}>
      <div className="menu-title">{nickname}</div>
      {(['voice', 'stream'] as const).map((kind) => {
        const pct = Math.round(volume[kind] * 100)
        return (
          <label key={kind} className="menu-slider">
            <span>
              {kind === 'voice' ? 'Volume da voz' : 'Volume da transmissão'}
              <b className={pct > 100 ? 'boosted' : pct === 0 ? 'muted-pct' : ''}>{pct}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={MAX_PCT}
              step={5}
              value={pct}
              onChange={(e) => setUserVolume(nickname, kind, Number(e.target.value) / 100)}
              onDoubleClick={() => setUserVolume(nickname, kind, 1)}
              title="Duplo clique volta para 100%"
            />
          </label>
        )
      })}
      {boosted && <p className="menu-hint">Acima de 100%, use fone para não dar eco.</p>}
      {changed && (
        <button className="menu-reset" onClick={() => resetUserVolume(nickname)}>
          Voltar para 100%
        </button>
      )}
    </div>
  )
}
