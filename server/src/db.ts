import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

export interface Channel {
  id: string
  name: string
  position: number
}

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  url: string
}

export interface Message {
  id: number
  channelId: string
  userId: string
  nickname: string
  content: string
  attachments: Attachment[]
  createdAt: number
}

const db = new DatabaseSync(join(config.dataDir, 'resenha.db'))

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    content TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`)

// ---------- canais ----------

const newId = () => randomBytes(4).toString('hex')

export function listChannels(): Channel[] {
  return db
    .prepare('SELECT id, name, position FROM channels ORDER BY position, created_at')
    .all() as unknown as Channel[]
}

export function getChannel(id: string): Channel | undefined {
  return db.prepare('SELECT id, name, position FROM channels WHERE id = ?').get(id) as
    | Channel
    | undefined
}

export function createChannel(name: string): Channel {
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels').get() as {
    next: number
  }
  const channel = { id: newId(), name, position: row.next }
  db.prepare('INSERT INTO channels (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(
    channel.id,
    channel.name,
    channel.position,
    Date.now(),
  )
  return channel
}

export function renameChannel(id: string, name: string): void {
  db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, id)
}

export function deleteChannel(id: string): void {
  db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id)
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
}

const { count } = db.prepare('SELECT COUNT(*) AS count FROM channels').get() as { count: number }
if (count === 0) {
  for (const name of config.defaultChannels) createChannel(name)
}

// ---------- anexos ----------

interface AttachmentRow {
  id: string
  file: string
  name: string
  mime: string
  size: number
}

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  size: row.size,
  url: `/files/${row.file}`,
})

export function insertAttachment(
  row: AttachmentRow & { userId: string },
): Attachment {
  db.prepare(
    'INSERT INTO attachments (id, file, name, mime, size, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.file, row.name, row.mime, row.size, row.userId, Date.now())
  return toAttachment(row)
}

export function getAttachments(ids: string[], userId: string): Attachment[] {
  const stmt = db.prepare(
    'SELECT id, file, name, mime, size FROM attachments WHERE id = ? AND user_id = ?',
  )
  return ids
    .map((id) => stmt.get(id, userId) as AttachmentRow | undefined)
    .filter((row): row is AttachmentRow => !!row)
    .map(toAttachment)
}

// ---------- mensagens ----------

interface MessageRow {
  id: number
  channel_id: string
  user_id: string
  nickname: string
  content: string
  attachments: string
  created_at: number
}

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  channelId: row.channel_id,
  userId: row.user_id,
  nickname: row.nickname,
  content: row.content,
  attachments: JSON.parse(row.attachments) as Attachment[],
  createdAt: row.created_at,
})

export function getMessages(channelId: string, before: number | undefined, limit: number): Message[] {
  const rows = (
    before
      ? db
          .prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
          .all(channelId, before, limit)
      : db
          .prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?')
          .all(channelId, limit)
  ) as unknown as MessageRow[]
  return rows.reverse().map(toMessage)
}

export function getMessage(id: number): Message | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
  return row && toMessage(row)
}

export function insertMessage(m: Omit<Message, 'id' | 'createdAt'>): Message {
  const createdAt = Date.now()
  const result = db
    .prepare(
      'INSERT INTO messages (channel_id, user_id, nickname, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(m.channelId, m.userId, m.nickname, m.content, JSON.stringify(m.attachments), createdAt)
  return { ...m, id: Number(result.lastInsertRowid), createdAt }
}

export function deleteMessage(id: number): void {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id)
}
