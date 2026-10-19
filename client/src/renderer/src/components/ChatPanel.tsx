import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatSize, formatTime } from '../lib/format'
import { optimizeImage } from '../lib/image'
import { emit, request } from '../lib/socket'
import type { Attachment, Message } from '../lib/types'
import { showToast, useStore } from '../store'
import { Avatar } from './Avatar'
import { CloseIcon, DownloadIcon, FileIcon, PaperclipIcon, TrashIcon } from './Icons'
import { ConfirmModal } from './Modal'

const GROUP_WINDOW = 5 * 60_000
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g

export function ChatPanel({ channelId }: { channelId: string }) {
  const api = useStore((s) => s.api)!
  const me = useStore((s) => s.session!.user)
  const maxUploadMb = useStore((s) => s.session!.server.maxUploadMb)
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
  const messages = useStore((s) => s.messages[channelId])
  const hasMore = useStore((s) => s.hasMore[channelId])
  const typingMap = useStore((s) => s.typing[channelId])

  const listRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const restoreScroll = useRef<{ height: number; top: number } | null>(null)
  const loadingOlder = useRef(false)
  const lastTyping = useRef(0)

  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [preparing, setPreparing] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null)
  const [toDelete, setToDelete] = useState<Message | null>(null)
  const [now, setNow] = useState(Date.now())

  // ---------- carregar histórico ----------

  const load = async (before?: number) => {
    try {
      const list = await api.messages(channelId, before)
      useStore.setState((s) => ({
        messages: {
          ...s.messages,
          [channelId]: before ? [...list, ...(s.messages[channelId] ?? [])] : list,
        },
        hasMore: { ...s.hasMore, [channelId]: list.length >= 50 },
      }))
    } catch (err) {
      showToast(`Erro ao carregar mensagens: ${(err as Error).message}`)
    }
  }

  useEffect(() => {
    if (messages === undefined) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, messages === undefined])

  const onScroll = async () => {
    const el = listRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 60 && hasMore && !loadingOlder.current && messages?.length) {
      loadingOlder.current = true
      restoreScroll.current = { height: el.scrollHeight, top: el.scrollTop }
      await load(messages[0].id)
      loadingOlder.current = false
    }
  }

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (restoreScroll.current) {
      el.scrollTop = el.scrollHeight - restoreScroll.current.height + restoreScroll.current.top
      restoreScroll.current = null
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const keepAtBottom = () => {
    const el = listRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }

  // ---------- "fulano está digitando" ----------

  const typers = Object.entries(typingMap ?? {})
    .filter(([, expires]) => expires > now)
    .map(([name]) => name)

  useEffect(() => {
    if (!typingMap || Object.keys(typingMap).length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [typingMap])

  // ---------- envio ----------

  const addFiles = async (list: File[]) => {
    if (list.length === 0) return
    setPreparing((n) => n + 1)
    try {
      const prepared = useStore.getState().settings.optimizeImages
        ? await Promise.all(list.map(optimizeImage))
        : list
      const ok = prepared.filter((f) => {
        if (f.size > maxUploadMb * 1024 * 1024) {
          showToast(`"${f.name}" passa do limite de ${maxUploadMb} MB`)
          return false
        }
        return true
      })
      setFiles((prev) => [...prev, ...ok].slice(0, 10))
    } finally {
      setPreparing((n) => n - 1)
    }
  }

  const send = async () => {
    if (sending || preparing > 0 || (!text.trim() && files.length === 0)) return
    setSending(true)
    try {
      const attachments = await Promise.all(files.map((f) => api.upload(f)))
      const res = await request('message:send', {
        channelId,
        content: text,
        attachmentIds: attachments.map((a) => a.id),
      })
      if (!res.ok) throw new Error(res.error)
      setText('')
      setFiles([])
      atBottom.current = true
    } catch (err) {
      showToast(`Não foi possível enviar: ${(err as Error).message}`)
    } finally {
      setSending(false)
    }
  }

  const onChange = (value: string) => {
    setText(value)
    if (value && Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now()
      emit('typing', { channelId })
    }
  }

  // ---------- render ----------

  return (
    <section
      className={`chat${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        addFiles([...e.dataTransfer.files])
      }}
    >
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {messages === undefined && <p className="muted center">Carregando…</p>}
        {messages && !hasMore && (
          <div className="chat-start">
            <h3>Bem-vindo a #{channel?.name}</h3>
            <p className="muted">Este é o começo do chat deste canal.</p>
          </div>
        )}
        {messages?.map((m, i) => {
          const prev = messages[i - 1]
          const grouped =
            prev && prev.userId === m.userId && m.createdAt - prev.createdAt < GROUP_WINDOW
          return (
            <div key={m.id} className={`message${grouped ? ' grouped' : ''}`}>
              {grouped ? (
                <div className="message-gutter" />
              ) : (
                <Avatar name={m.nickname} size={36} />
              )}
              <div className="message-body">
                {!grouped && (
                  <div className="message-header">
                    <span className="message-author">{m.nickname}</span>
                    <span className="message-time">{formatTime(m.createdAt)}</span>
                  </div>
                )}
                {m.content && <div className="message-text">{linkify(m.content)}</div>}
                {m.attachments.map((a) => (
                  <AttachmentView
                    key={a.id}
                    attachment={a}
                    src={api.url(a.url)}
                    onLoad={keepAtBottom}
                    onOpenImage={setLightbox}
                  />
                ))}
              </div>
              {m.userId === me.id && (
                <button
                  className="message-delete icon-btn"
                  title="Apagar mensagem"
                  onClick={() => setToDelete(m)}
                >
                  <TrashIcon size={16} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="composer">
        {files.length > 0 && (
          <div className="pending-files">
            {files.map((f, i) => (
              <PendingFile
                key={`${f.name}:${i}`}
                file={f}
                onRemove={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}
          </div>
        )}
        <div className="composer-row">
          <label className="icon-btn" title="Enviar arquivo">
            <PaperclipIcon size={20} />
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
          </label>
          <textarea
            rows={1}
            value={text}
            placeholder={`Conversar em #${channel?.name ?? ''}`}
            maxLength={4000}
            onChange={(e) => onChange(e.target.value)}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files]
              if (pasted.length) {
                e.preventDefault()
                addFiles(pasted)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
        </div>
        <div className="typing">
          {sending
            ? 'Enviando…'
            : preparing > 0
              ? 'Otimizando imagem…'
            : typers.length === 1
              ? `${typers[0]} está digitando…`
              : typers.length > 1
                ? `${typers.join(', ')} estão digitando…`
                : ''}
        </div>
      </div>

      {dragging && <div className="drop-overlay">Solte para enviar</div>}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.src} alt="" />
          <button
            className="lightbox-download"
            onClick={(e) => {
              e.stopPropagation()
              window.api.downloadFile(lightbox.src, lightbox.name)
            }}
          >
            <DownloadIcon size={18} /> Baixar
          </button>
        </div>
      )}
      {toDelete && (
        <ConfirmModal
          title="Apagar mensagem"
          text="Tem certeza que quer apagar esta mensagem?"
          confirmText="Apagar"
          onClose={() => setToDelete(null)}
          onConfirm={async () => {
            const res = await request('message:delete', { id: toDelete.id })
            if (!res.ok) showToast(res.error ?? 'Erro')
            setToDelete(null)
          }}
        />
      )}
    </section>
  )
}

function linkify(text: string): ReactNode {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}

function AttachmentView({
  attachment: a,
  src,
  onLoad,
  onOpenImage,
}: {
  attachment: Attachment
  src: string
  onLoad: () => void
  onOpenImage: (image: { src: string; name: string }) => void
}) {
  if (a.mime.startsWith('image/') && a.mime !== 'image/svg+xml') {
    return (
      <div className="attachment-image-wrap">
        <img
          className="attachment-image"
          src={src}
          alt={a.name}
          loading="lazy"
          onLoad={onLoad}
          onClick={() => onOpenImage({ src, name: a.name })}
        />
        <button
          className="attachment-download icon-btn"
          title="Baixar"
          onClick={() => window.api.downloadFile(src, a.name)}
        >
          <DownloadIcon size={18} />
        </button>
      </div>
    )
  }
  if (a.mime.startsWith('video/')) {
    return (
      <video className="attachment-video" src={src} controls preload="metadata" onLoadedMetadata={onLoad} />
    )
  }
  if (a.mime.startsWith('audio/')) {
    return <audio className="attachment-audio" src={src} controls preload="metadata" />
  }
  return (
    <a
      className="attachment-file"
      href={src}
      onClick={(e) => {
        e.preventDefault()
        window.api.downloadFile(src, a.name)
      }}
    >
      <FileIcon size={28} />
      <span>
        <b>{a.name}</b>
        <small>{formatSize(a.size)}</small>
      </span>
    </a>
  )
}

function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (!file.type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  return (
    <div className="pending-file">
      {preview ? <img src={preview} alt="" /> : <FileIcon size={28} />}
      <span title={file.name}>{file.name || 'imagem colada'}</span>
      <small>{formatSize(file.size)}</small>
      <button className="icon-btn" title="Remover" onClick={onRemove}>
        <CloseIcon size={14} />
      </button>
    </div>
  )
}
