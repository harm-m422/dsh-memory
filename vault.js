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

/** chmod 是 POSIX 语义；Windows 上可能抛 EPERM，所以做成尽力而为。 */
function safeChmod(target, mode) {
  try { chmodSync(target, mode) } catch { /* 平台不适用就当成功 */ }
}
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DIR = HOME + '/memory'
const KEY_FILE = DIR + '/master.key'
const VERSION = 1

/** The 32-byte master key, generated once and kept at 0600. */
let cached = null

/**
 * The key file exists but cannot be used. This is deliberately fatal for writes:
 * minting a fresh key here would overwrite a key that may still be recoverable,
 * and everything sealed afterwards could never be read again. Callers must let
 * this surface rather than swallowing it into a normalised return value.
 */
export class VaultKeyError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'VaultKeyError'
    this.cause = cause
  }
}

/** Mint the very first key. Only ever called when the file is proven absent. */
function createKey() {
  const key = randomBytes(32)
  try {
    mkdirSync(DIR, { recursive: true })
  } catch (error) {
    // The directory itself could not be created (a file sits where it should be,
    // or permissions forbid it). That is not a key race, so it must not fall
    // through to the adopt-the-winner branch below.
    throw new VaultKeyError('cannot create the memory directory ' + DIR + ': ' + String((error && error.message) || error), error)
  }
  try {
    // 'wx' turns the write into a create: if another process won the race we do
    // not clobber its key, we adopt it.
    writeFileSync(KEY_FILE, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' })
    safeChmod(KEY_FILE, 0o600)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
      // Lost the race: re-read and use the winner's key.
      let raw
      try {
        raw = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'base64')
      } catch (readError) {
        throw new VaultKeyError('a master key exists but could not be read after a write race', readError)
      }
      if (raw.length === 32) {
        cached = raw
        return cached
      }
      throw new VaultKeyError('master key appeared but is not a valid 32-byte key', error)
    }
    // Refusing to keep an unpersisted key: anything sealed now would be
    // undecryptable after a restart, which is worse than failing the write.
    throw new VaultKeyError('cannot persist a new master key to ' + KEY_FILE + ': ' + String((error && error.message) || error), error)
  }
  cached = key
  return cached
}

function masterKey() {
  if (cached !== null) return cached
  let text
  try {
    text = readFileSync(KEY_FILE, 'utf8')
  } catch (error) {
    // Only a genuinely absent file justifies minting a key. A permission or I/O
    // failure must never be read as "not initialised yet" — that is the exact
    // confusion that used to rotate a recoverable key out from under the data.
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return createKey()
    throw new VaultKeyError('master key exists but could not be read (' + String((error && error.code) || (error && error.message) || error) + '); refusing to replace it', error)
  }
  // The file is present, so it must be a valid key. Damage is not absence.
  const trimmed = text.trim()
  const raw = Buffer.from(trimmed, 'base64')
  if (raw.length !== 32 || raw.toString('base64') !== trimmed) {
    throw new VaultKeyError('master key file is damaged (' + String(raw.length) + ' bytes decoded, expected 32); refusing to replace it', null)
  }
  cached = raw
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
  // Resolve the key outside the catch: a broken/unreadable key is a different
  // fault from "this ciphertext no longer matches", and conflating them would
  // report a recoverable key problem as if the data itself were gone.
  const key = masterKey()
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(field.iv), 'base64'))
    decipher.setAuthTag(Buffer.from(String(field.tag), 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(String(field.data), 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export const KEY_PATH = KEY_FILE
