// dsh-memory — 完整对话档案。
//
// 四域记的是"结论"，这里记的是"原文"：一轮对话里的每条用户消息、助手的每段话、
// 每次工具调用与结果，都从会话日志里派生出来，落成一份可以回读的 JSONL。
// 格式与 dsh-memory-acc 完全一致（conversation.jsonl / conversation.jsonl.acc + manifest.json），
// 所以两个引擎写的档案互相可读，换引擎不用搬数据。
//
// 只读会话日志，从不往里写：日志里出现未知事件类型会让会话拒绝重开。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as zlib from 'node:zlib'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DIR = HOME + '/diary'
const CONFIG = join(DIR, 'extras.json')
const KEY_FILE = join(DIR, 'archive.key')
const CACHE_FILE = join(DIR, 'attachments.json')
const LOG_NAME = 'session.v4.jsonl.zstd'
const FALLBACK_LOG = 'session.v3.jsonl.zstd'

function home() {
  return HOME
}

/** Archive settings; a missing file means "store inside the diary directory, plain text". */
export function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG, 'utf8'))
    return {
      ...(parsed !== null && typeof parsed === 'object' ? parsed : {}),
      archiveRoot: typeof parsed.archiveRoot === 'string' ? parsed.archiveRoot : '',
      encrypt: parsed.encrypt === true
    }
  } catch {
    return { archiveRoot: '', encrypt: false }
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  mkdirSync(DIR, { recursive: true })
  writeFileSync(CONFIG, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

export function archiveRoot() {
  const config = readConfig()
  return config.archiveRoot.length > 0 ? config.archiveRoot : join(DIR, 'archive')
}

/** The archive key: env first, then the file beside the data. Never echoed back. */
export function archiveKey() {
  const fromEnv = process.env.DSH_MEMORY_ARCHIVE_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  try { return readFileSync(KEY_FILE, 'utf8').trim() } catch { return '' }
}

/** Same envelope as dsh-memory-acc: "ACC1" + salt + iv + tag + body. */
function seal(buffer, password) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(buffer), cipher.final()])
  return Buffer.concat([Buffer.from('ACC1'), salt, iv, cipher.getAuthTag(), body])
}

function unseal(buffer, password) {
  const salt = buffer.subarray(4, 20)
  const iv = buffer.subarray(20, 32)
  const tag = buffer.subarray(32, 48)
  const key = scryptSync(password, salt, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(buffer.subarray(48)), decipher.final()])
}

/**
 * Decode every zstd frame in a session log. The CLI walks all frames; the Node
 * stream is a fallback (a partial decode silently yields just the header event).
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Node 的 zstd 解压只解到**第一个帧**就停。会话日志是按 flush 追加的多帧文件，
 * 所以对整块调用 zstdDecompressSync 只能拿到那个 header —— Windows 上就表现为
 * "归档成功，但 0 条记录"。这里按帧头切开逐帧解；某一段解不开（帧头是数据里的
 * 假阳性）就吞进下一段再试。
 */
function decodeZstdFrames(buf) {
  const chunks = []
  let pos = 0
  while (pos < buf.length) {
    const next = buf.indexOf(ZSTD_MAGIC, pos + 4)
    chunks.push(buf.subarray(pos, next === -1 ? buf.length : next))
    if (next === -1) break
    pos = next
  }
  const out = []
  let i = 0
  while (i < chunks.length) {
    let merged = chunks[i]
    let done = false
    for (let j = i; j < chunks.length; j += 1) {
      if (j > i) merged = Buffer.concat([merged, chunks[j]])
      try { out.push(zlib.zstdDecompressSync(merged)); i = j + 1; done = true; break } catch { /* 假帧头，继续合 */ }
    }
    if (!done) break
  }
  return Buffer.concat(out)
}

function decodeLog(path) {
  let cli = { status: null, stdout: Buffer.alloc(0), stderr: '' }
  if (process.platform !== 'win32') {
    try { cli = spawnSync('zstd', ['-dc', path], { maxBuffer: 512 * 1024 * 1024 }) } catch { /* 没有就没有 */ }
  }
  if (cli.status === 0 && cli.stdout.length > 0) return { text: cli.stdout.toString('utf8'), how: 'zstd-cli' }
  // 没有命令行 zstd（Windows 默认没有）时走进程内解码，必须按帧切
  if (typeof zlib.zstdDecompressSync === 'function') {
    const buf = readFileSync(path)
    return { text: decodeZstdFrames(buf).toString('utf8'), how: 'node-zstd-frames' }
  }
  // 没有进程内 zstd 时不能再退回"子进程流"：那条路同样只解第一帧，
  // 会写出一份"归档成功但 0 条记录"的假档案。宁可报错。
  throw new Error('这个运行时没有 zstd（需要 Node ≥ 22.15，或带 zstd 的构建）：无法解码会话日志')
}

/** Every image attachment id in a message, in order. */
function imageIds(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return []
  const out = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object' || block.type !== 'image') continue
    const id = String(block.attachment?.attachmentId ?? block.attachmentId ?? '')
    if (id.length > 0) out.push(id)
  }
  return out
}

/** One line of readable text for any content block. */
function blockText(block) {
  if (block === null || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text': return String(block.text ?? '')
    case 'reasoning': return ''
    case 'tool-call': return '[调用 ' + String(block.name ?? '?') + '] ' + JSON.stringify(block.arguments ?? block.input ?? {})
    case 'image': return '[图片 ' + String(block.attachment?.attachmentId ?? block.attachmentId ?? '?') + ']'
    case 'file': return '[文件 ' + String(block.attachment?.name ?? '?') + ']'
    default: return ''
  }
}

/** Normalise one stored event into an archive record, or null when not kept. */
function toRecord(event) {
  if (event === null || typeof event !== 'object') return null
  const type = String(event.type ?? '')
  const at = typeof event.time === 'number' ? new Date(event.time).toISOString() : ''
  const data = event.data ?? {}

  if (type === 'user/message') {
    const message = data.message ?? data
    const text = Array.isArray(message.content) ? message.content.map(blockText).filter(Boolean).join('\n') : String(message.text ?? '')
    return { seq: event.seq, at, role: 'user', kind: 'message', text, images: imageIds(message) }
  }
  if (type === 'assistant/message') {
    const message = data.message ?? data
    const text = Array.isArray(message.content) ? message.content.map(blockText).filter(Boolean).join('\n') : ''
    return { seq: event.seq, at, role: 'assistant', kind: 'message', text, images: imageIds(message) }
  }
  if (type === 'tool/call') {
    return { seq: event.seq, at, role: 'tool', kind: 'call', text: String(data.name ?? data.toolName ?? '?') + ' ' + JSON.stringify(data.arguments ?? {}) }
  }
  if (type === 'tool/result') {
    const content = Array.isArray(data.content) ? data.content.map(blockText).filter(Boolean).join('\n') : String(data.text ?? '')
    return { seq: event.seq, at, role: 'tool', kind: 'result', text: content }
  }
  if (type === 'system/message' || type === 'developer/message') {
    const message = data.message ?? data
    const text = Array.isArray(message.content) ? message.content.map(blockText).filter(Boolean).join('\n') : ''
    return { seq: event.seq, at, role: type.startsWith('system') ? 'system' : 'developer', kind: 'message', text }
  }
  return null
}

/** Every session directory under DSH_HOME/sessions, newest first. */
export function listSessions() {
  const root = join(home(), 'sessions')
  if (!existsSync(root)) return []
  const found = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    if (!statSync(wsDir).isDirectory()) continue
    for (const session of readdirSync(wsDir)) {
      const dir = join(wsDir, session)
      let info = null
      try { info = statSync(dir) } catch { continue }
      if (!info.isDirectory()) continue
      const log = existsSync(join(dir, LOG_NAME)) ? join(dir, LOG_NAME) : (existsSync(join(dir, FALLBACK_LOG)) ? join(dir, FALLBACK_LOG) : null)
      if (log === null) continue
      found.push({ workspace, session, dir, log, bytes: statSync(log).size, mtime: info.mtimeMs })
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

// 图片只留"这张图讲了什么"：附件迟早会被删，像素存不下来，描述可以。
function descriptionCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveDescription(id, text) {
  const cache = descriptionCache()
  cache[id] = { text, at: new Date().toISOString() }
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 })
  } catch { /* 缓存写不进去不影响归档 */ }
}

function applyImageTexts(records, provided) {
  if (Array.isArray(provided)) {
    for (const entry of provided) {
      if (entry === null || typeof entry !== 'object') continue
      const id = String(entry.id ?? '').trim()
      const text = String(entry.text ?? '').trim().slice(0, 400)
      if (id.length > 0 && text.length > 0) saveDescription(id, text)
    }
  }
  const cache = descriptionCache()
  for (const record of records) {
    if (!Array.isArray(record.images) || record.images.length === 0) continue
    let text = String(record.text ?? '')
    for (const id of record.images) {
      const known = cache[id]
      const described = known !== undefined && typeof known.text === 'string' ? known.text : ''
      text = text.split('[图片 ' + id + ']').join(described.length > 0 ? '[图片：' + described + ']' : '[图片 未识别 ' + id.slice(0, 8) + '…]')
    }
    record.text = text
  }
  return records
}

/** Archive one conversation. `session` omitted = the newest log on disk. */
export function archiveSession(options) {
  const input = options ?? {}
  const all = listSessions()
  if (all.length === 0) return { ok: false, error: '没有找到任何会话日志（' + join(home(), 'sessions') + '）' }
  const wanted = typeof input.session === 'string' ? input.session.trim() : ''
  const target = wanted.length > 0 ? all.find((s) => s.session === wanted) : all[0]
  if (target === undefined) return { ok: false, error: '没有这个会话：' + wanted }

  const decoded = decodeLog(target.log)
  const events = []
  for (const line of decoded.text.split('\n')) {
    if (line.trim().length === 0) continue
    try { events.push(JSON.parse(line)) } catch { /* 写了一半的尾行不算错 */ }
  }
  const records = []
  for (const event of events) {
    const record = toRecord(event)
    if (record !== null) records.push(record)
  }
  applyImageTexts(records, input.images)

  const outDir = join(archiveRoot(), target.workspace, target.session)
  mkdirSync(outDir, { recursive: true })
  const payload = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const config = readConfig()
  const password = archiveKey()
  const sealed = config.encrypt && password.length > 0
  writeFileSync(join(outDir, sealed ? 'conversation.jsonl.acc' : 'conversation.jsonl'), sealed ? seal(payload, password) : payload, { mode: 0o600 })
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
    session: target.session,
    workspace: target.workspace,
    sourceLog: target.log,
    sourceBytes: target.bytes,
    events: events.length,
    decode: decoded.how,
    kept: records.length,
    archivedAt: new Date().toISOString(),
    note: 'derived from the session log; the log itself was not modified'
  }, null, 2) + '\n')

  const counts = records.reduce((acc, r) => { acc[r.role] = (acc[r.role] ?? 0) + 1; return acc }, {})
  return { ok: true, session: target.session, workspace: target.workspace, events: events.length, kept: records.length, counts, dir: outDir, sealed, file: sealed ? 'conversation.jsonl.acc' : 'conversation.jsonl' }
}

/** Every archived conversation, newest first. */
export function archivedSessions(limit) {
  const root = archiveRoot()
  if (!existsSync(root)) return []
  const out = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let isDir = false
    try { isDir = statSync(wsDir).isDirectory() } catch { continue }
    if (!isDir) continue
    for (const session of readdirSync(wsDir)) {
      const dir = join(wsDir, session)
      const plain = join(dir, 'conversation.jsonl')
      const sealedFile = join(dir, 'conversation.jsonl.acc')
      out.push({ workspace, session, dir, plain: existsSync(plain), sealed: existsSync(sealedFile) })
    }
  }
  return out.slice(0, limit === undefined ? 40 : limit)
}

/** Read one archived conversation as text; sealed files need the configured key. */
function readArchive(entry) {
  if (entry.plain) return readFileSync(join(entry.dir, 'conversation.jsonl'), 'utf8')
  if (entry.sealed) {
    const password = archiveKey()
    if (password.length === 0) return ''
    try { return unseal(readFileSync(join(entry.dir, 'conversation.jsonl.acc')), password).toString('utf8') } catch { return '' }
  }
  return ''
}

/** Split a query into words: spaces, commas, slashes and full-width punctuation. */
function tokensOf(text) {
  const parts = String(text ?? '').toLowerCase()
    .split(/[\s,，、/|;；:：()（）"']+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
  const unique = Array.from(new Set(parts))
  if (unique.length > 0) return unique
  const whole = String(text ?? '').trim().toLowerCase()
  return whole.length > 0 ? [whole] : []
}

/** Search the archive by a handful of words, not by the exact phrase. */
export function searchArchives(query, limit) {
  const words = tokensOf(query)
  if (words.length === 0) return []
  const hits = []
  for (const entry of archivedSessions(40)) {
    const text = readArchive(entry)
    if (text.length === 0) continue
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      const body = String(record.text ?? '')
      if (body.length === 0) continue
      const lower = body.toLowerCase()
      let score = 0
      for (const word of words) if (lower.includes(word)) score += 1
      if (score > 0) hits.push({ score, session: entry.session, role: record.role, at: record.at, text: body })
    }
  }
  hits.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
  return hits.slice(0, limit === undefined ? 12 : limit)
}

/** One line for the panel: how much is archived. */
export function archiveSummary() {
  const list = archivedSessions(1000)
  return {
    count: list.length,
    root: archiveRoot(),
    encrypt: readConfig().encrypt,
    hasKey: archiveKey().length > 0,
    sessions: list.slice(0, 20).map((s) => ({ session: s.session, workspace: s.workspace, sealed: s.sealed }))
  }
}
