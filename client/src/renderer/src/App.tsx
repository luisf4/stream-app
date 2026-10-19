import { Connect } from './screens/Connect'
import { Main } from './screens/Main'
import { useStore } from './store'

export function App() {
  const session = useStore((s) => s.session)
  const toast = useStore((s) => s.toast)

  if (session) return <Main key={session.token} />
  return (
    <>
      <Connect />
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
