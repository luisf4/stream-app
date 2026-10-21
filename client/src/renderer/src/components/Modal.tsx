import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CloseIcon } from './Icons'

export function Modal({
  title,
  onClose,
  children,
  wide = false,
  className = '',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''} ${className}`} role="dialog" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Fechar">
            <CloseIcon />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

/** Substitui o window.prompt (que não existe no Electron). */
export function PromptModal({
  title,
  label,
  initial = '',
  confirmText = 'Salvar',
  onSubmit,
  onClose,
}: {
  title: string
  label: string
  initial?: string
  confirmText?: string
  onSubmit: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.select(), [])

  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input ref={input} value={value} maxLength={40} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {confirmText}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ConfirmModal({
  title,
  text,
  confirmText,
  onConfirm,
  onClose,
}: {
  title: string
  text: string
  confirmText: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{text}</p>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn danger" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    </Modal>
  )
}
