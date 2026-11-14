// dsh-memory — 八面性格。
//
// 四域记的是事实，这里记的是判断：从真实对话里，模型对"这个人"和"它自己"分别
// 看到什么。八面 × 两个人，各自独立成条——合在一起就成了"用户画像"，那不是这里要的。
//
// 数据独立（diary/persona.json），不折进四域：性格是印象，不是档案条文。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DIR = HOME + '/diary'
const PERSONA_FILE = join(DIR, 'persona.json')

export const FACETS = ['temper', 'mouth', 'affinity', 'habits', 'likes', 'manner', 'style', 'ability']
export const FACET_LABEL = {
  temper: '性格', mouth: '口吻', affinity: '好感', habits: '习惯',
  likes: '喜欢的物品', manner: '习惯的作风', style: '风格', ability: '能力'
}
export const SUBJECTS = ['you', 'me']

const PER_FACET_CAP = 12

function emptyFacets() {
  const out = {}
  for (const facet of FACETS) out[facet] = []
  return out
}

export function personaFile() {
  return PERSONA_FILE
}

export function readPersona() {
  const blank = { updatedAt: '', you: emptyFacets(), me: emptyFacets() }
  let parsed = null
  try { parsed = JSON.parse(readFileSync(PERSONA_FILE, 'utf8')) } catch { return blank }
  if (parsed === null || typeof parsed !== 'object') return blank
  // A flat file from before the split is folded into "you": that is who it described.
  const flat = FACETS.some((facet) => Array.isArray(parsed[facet]))
  const out = { updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '', you: emptyFacets(), me: emptyFacets() }
  for (const subject of SUBJECTS) {
    const source = flat && subject === 'you' ? parsed : (parsed[subject] ?? {})
    for (const facet of FACETS) out[subject][facet] = Array.isArray(source[facet]) ? source[facet] : []
  }
  return out
}

export function writePersona(next) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(PERSONA_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/** Add one line to one facet of one subject; duplicates are dropped, list capped. */
export function addFacet(persona, subject, facet, text) {
  if (!SUBJECTS.includes(subject)) throw new Error('subject must be you or me')
  if (!FACETS.includes(facet)) throw new Error('facet must be one of ' + FACETS.join(', '))
  const next = { ...persona, updatedAt: new Date().toISOString(), you: { ...persona.you }, me: { ...persona.me } }
  const list = Array.isArray(next[subject][facet]) ? next[subject][facet].slice() : []
  if (text.length > 0 && list.indexOf(text) < 0) list.push(text)
  next[subject][facet] = list.slice(-PER_FACET_CAP)
  return next
}

/** Merge model output ({you:{…},me:{…}}) into what is stored. */
export function mergePersona(previous, incoming) {
  const next = { updatedAt: new Date().toISOString(), you: {}, me: {} }
  for (const subject of SUBJECTS) {
    for (const facet of FACETS) {
      const before = Array.isArray(previous[subject][facet]) ? previous[subject][facet] : []
      const raw = incoming !== null && typeof incoming === 'object' ? incoming[subject] : undefined
      const fresh = raw !== undefined && Array.isArray(raw[facet])
        ? raw[facet].filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim().slice(0, 120))
        : []
      const merged = []
      for (const item of fresh.concat(before)) if (merged.indexOf(item) < 0) merged.push(item)
      next[subject][facet] = merged.slice(0, PER_FACET_CAP)
    }
  }
  return next
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** What goes into the prompt: a few lines per person, not the whole file. */
export function personaText(perFacet) {
  const persona = readPersona()
  const each = perFacet === undefined ? 2 : perFacet
  const lines = []
  for (const subject of SUBJECTS) {
    const parts = []
    for (const facet of FACETS) {
      const list = persona[subject][facet]
      if (!Array.isArray(list) || list.length === 0) continue
      parts.push(FACET_LABEL[facet] + '：' + list.slice(-each).map(oneLine).join('；'))
    }
    if (parts.length > 0) lines.push((subject === 'you' ? '你' : '我') + ' —— ' + parts.join(' · '))
  }
  if (lines.length === 0) return ''
  const body = '印象（性格）：这些是印象，不是档案条文。\n' + lines.join('\n')
  return clip(body, 700).replaceAll('{{', '{ {')
}

/** Ask the harness model to read a stretch of conversation and say what it makes of the two people. */
export async function distill(llm, text) {
  const system = [
    '你要从一段真实对话里描摹两个人：对话里的人类，和你自己（模型这一侧）。',
    '以你的主观印象写，不需要客观，也不要美化；只写你确实从这段对话里看到的。',
    '两条规则：',
    '1. 关于人类的话放进 you，关于你自己的话放进 me，不要混。',
    '2. 每面是一个字符串数组，每条不超过 40 字；没有内容就给空数组。',
    '面名：' + JSON.stringify(FACET_LABEL),
    '只输出 JSON，形如 {"you":{...},"me":{...}}，不要解释。'
  ].join('\n')
  const messages = [{ role: 'user', content: [{ type: 'text', text: system + '\n\n对话：\n' + String(text ?? '').slice(0, 12000) }] }]
  const said = []
  for await (const chunk of llm.stream({ provider: 'deepseek-official', model: 'deepseek-flash', messages, maxTokens: 4000 })) {
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') said.push(String(chunk.text ?? ''))
  }
  const raw = said.join('')
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last <= first) return { __raw: raw.slice(0, 400), __chars: raw.length }
  try { return JSON.parse(raw.slice(first, last + 1)) } catch { return { __raw: raw.slice(0, 400), __chars: raw.length } }
}

/** Counts for the panel: per subject, per facet. */
export function personaSummary() {
  const persona = readPersona()
  const counts = { you: {}, me: {} }
  for (const subject of SUBJECTS) for (const facet of FACETS) counts[subject][facet] = persona[subject][facet].length
  return { updatedAt: persona.updatedAt, counts, file: PERSONA_FILE, exists: existsSync(PERSONA_FILE) }
}
