// dsh-memory — 恍惚：会自己浮上来的记忆。
//
// 大多数记忆是"被问才想起"，人不是这样：偶尔有件事会自己冒出来，和当下未必相关。
// 所以这里不是检索，是浮现。它必须稀有，否则就是噪声。
//
// 三个约束叠在一起：每次装配 3% 概率、每 24 小时最多 2 次、淘汰按"被调用权重优先，
// 其次最新"——一条从没被想起过的记忆，比一条反复浮现的更该被丢掉。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DIR = HOME + '/diary'
const VIVID_FILE = join(DIR, 'vivid.json')

const VIVID_CHANCE = 0.03
const VIVID_PER_DAY = 2
const VIVID_CAP = 60

export const VIVID_KINDS = ['interesting', 'awkward']

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export function vividFile() {
  return VIVID_FILE
}

export function readVivid() {
  try {
    const parsed = JSON.parse(readFileSync(VIVID_FILE, 'utf8'))
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter((e) => e !== null && typeof e === 'object' && typeof e.text === 'string') : [],
      surfacedAt: Array.isArray(parsed.surfacedAt) ? parsed.surfacedAt.filter((t) => typeof t === 'number') : []
    }
  } catch {
    return { entries: [], surfacedAt: [] }
  }
}

export function writeVivid(next) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(VIVID_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/** Keep the most-called, then the newest. */
function consolidateVivid(state) {
  const sorted = state.entries.slice().sort((a, b) => {
    const wa = typeof a.calls === 'number' ? a.calls : 0
    const wb = typeof b.calls === 'number' ? b.calls : 0
    if (wa !== wb) return wb - wa
    return String(b.at ?? '').localeCompare(String(a.at ?? ''))
  })
  return sorted.slice(0, VIVID_CAP)
}

export function addVivid(kind, text) {
  if (!VIVID_KINDS.includes(kind)) throw new Error('kind must be interesting or awkward')
  const clean = String(text ?? '').trim().slice(0, 240)
  if (clean.length === 0) throw new Error('text is required')
  const state = readVivid()
  const entries = state.entries.filter((e) => e.text !== clean)
  entries.push({ id: entries.length + 1, kind, text: clean, at: new Date().toISOString(), calls: 0 })
  return writeVivid({ surfacedAt: state.surfacedAt, entries: consolidateVivid({ entries }) })
}

/** Maybe surface one. Returns a line for the prompt, or ''. */
export function maybeSurfaceVivid() {
  const state = readVivid()
  if (state.entries.length === 0) return ''
  const dayAgo = Date.now() - 86400000
  const recent = state.surfacedAt.filter((t) => t > dayAgo)
  if (recent.length >= VIVID_PER_DAY) return ''
  if (Math.random() >= VIVID_CHANCE) return ''
  const picked = state.entries.slice().sort((a, b) => {
    const wa = typeof a.calls === 'number' ? a.calls : 0
    const wb = typeof b.calls === 'number' ? b.calls : 0
    return wb - wa
  })[0]
  if (picked === undefined) return ''
  picked.calls = (typeof picked.calls === 'number' ? picked.calls : 0) + 1
  writeVivid({ entries: state.entries, surfacedAt: recent.concat([Date.now()]) })
  const label = picked.kind === 'awkward' ? '有点尴尬的事' : '有意思的事'
  return '（忽然想起一件' + label + '，和现在未必有关：' + oneLine(picked.text) + '）'
}

export function vividSummary() {
  const state = readVivid()
  const dayAgo = Date.now() - 86400000
  return {
    count: state.entries.length,
    surfacedToday: state.surfacedAt.filter((t) => t > dayAgo).length,
    cap: VIVID_CAP,
    file: VIVID_FILE,
    exists: existsSync(VIVID_FILE)
  }
}
