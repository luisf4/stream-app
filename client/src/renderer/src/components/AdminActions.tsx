import { request } from '../lib/socket'
import { showToast, useStore } from '../store'

/** Itens de admin no menu de um usuário (mutar na voz, expulsar da call, banir). */
export function AdminActions({
  userId,
  nickname,
  onDone,
}: {
  userId: string
  nickname: string
  onDone: () => void
}) {
  const isAdmin = useStore((s) => !!s.session?.user.admin)
  const me = useStore((s) => s.session?.user.id)
  const voice = useStore((s) => s.voiceStates.find((v) => v.userId === userId))
  if (!isAdmin || userId === me) return null

  const run = async (event: string, payload: Record<string, unknown>, done: string) => {
    onDone()
    const res = await request(event, { userId, ...payload })
    showToast(res.ok ? done : (res.error ?? 'Erro'))
  }

  return (
    <>
      {voice && (
        <>
          <button
            onClick={() =>
              voice.serverMuted
                ? run('admin:mute', { muted: false }, `${nickname} pode falar de novo`)
                : run('admin:mute', { muted: true }, `${nickname} foi mutado na voz`)
            }
          >
            {voice.serverMuted ? 'Desmutar na voz' : 'Mutar na voz'}
          </button>
          <button onClick={() => run('admin:kick', {}, `${nickname} saiu da call`)}>
            Expulsar da call
          </button>
        </>
      )}
      <button
        className="danger"
        onClick={() => {
          onDone()
          useStore.setState({ banTarget: { id: userId, nickname } })
        }}
      >
        Banir…
      </button>
    </>
  )
}
