// dsh-memory — at-rest vault for the two sensitive tiers.
//
// 性格 (persona) and 一级 (note) are sealed with AES-256-GCM before they touch
// disk. Every other tier stays plaintext, because it is either disposable or
// already public to every session.
//
// What this buys, stated without overclaiming:
//   · a stray `cat`, `grep`, backup, or another account sees ciphertext;
//   · a leaked copy of entries.jsonl/profiles.json is useless on its own.
// What it does NOT buy:
//   · it does not hide anything from this process — the plugin decrypts in order
//     to work, so code running on this machine can always ask it to;
//   · it is not protection from the agent. It is protection from the file.
//
// The key lives beside the data at ~/.dsh/memory/master.key (0600). That is
// deliberate: a key the plugin cannot reach is a key that cannot decrypt, and the
// point is hygiene rather than a boundary against a co-resident process.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const HOME = process.env.DSH_HOME ?? ((process.env.HOME ?? '.') + '/.dsh')
const DIR = HOME + '/memory'
const KEY_FILE = DIR + '/master.key'
const VERSION = 1

/** The 32-byte master key, generated once and kept at 0600. */
let cached = null

function masterKey() {
  if (cached !== null) return cached
  try {
    if (existsSync(KEY_FILE)) {
      const raw = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'base64')
      if (raw.length === 32) {
        cached = raw
        return cached
      }
    }
  } catch {
    // Unreadable key file falls through to generation.
  }
  cached = randomBytes(32)
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(KEY_FILE, cached.toString('base64') + '\n', { mode: 0o600 })
    chmodSync(KEY_FILE, 0o600)
  } catch {
    // An unwritable key file still works for this process's lifetime.
  }
  return cached
}

/** Whether a stored field is ciphertext rather than plain text. */
export function isSealed(field) {
  return field !== null && typeof field === 'object' && field.enc === VERSION && typeof field.data === 'string'
}

/** Encrypt one string into the stored shape. */
export function seal(text) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
  return {
    enc: VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64')
  }
}

/**
 * Decrypt one stored field. Returns the text, or `null` when the field is sealed
 * but cannot be opened — callers must treat null as "do not rewrite this", never
 * as "empty", or a rotated key would silently erase the record.
 */
export function open(field) {
  if (field === null || field === undefined) return ''
  if (typeof field === 'string') return field
  if (!isSealed(field)) return ''
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(String(field.iv), 'base64'))
    decipher.setAuthTag(Buffer.from(String(field.tag), 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(String(field.data), 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export const KEY_PATH = KEY_FILE
