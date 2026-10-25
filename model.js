// dsh-memory — the memory model client.
//
// A second model whose only job is to organise and answer for memory: turn one
// turn's digest into level-1 notes, consolidate what matters into level-2, and
// talk to a person about what is remembered. It never decides what the main
// model should do.
//
// Everything here is fail-soft. Memory is an optimisation, not a dependency: if
// the endpoint is down, slow, or returns prose instead of JSON, the caller keeps
// working and the failure is reported rather than thrown into the turn.
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

const HOME = process.env.DSH_HOME ?? ((process.env.HOME ?? '.') + '/.dsh')
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
/** Verified against api.deepseek.com: this id resolves to DeepSeek-V4.1-Flash. */
const MODEL_DEFAULT = 'deepseek-flash'
const KEY_FILE = HOME + '/memory/key'
const CONFIG_FILE = HOME + '/memory/config.json'
const STATS_FILE = HOME + '/memory/stats.json'

/** The API key, from the environment first so a secret can stay out of disk. */
function apiKey() {
  const fromEnv = process.env.DSH_MEMORY_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  try {
    return readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

/** Whether a memory model can be reached at all. */
export function modelReady() {
  return apiKey().length > 0
}

/** Where the key actually comes from, so the panel can say which one wins. */
export function keySource() {
  const fromEnv = process.env.DSH_MEMORY_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return 'env'
  try {
    return readFileSync(KEY_FILE, 'utf8').trim().length > 0 ? 'file' : ''
  } catch {
    return ''
  }
}

/**
 * Strip and sanity-check a pasted key. Whitespace is rejected rather than
 * trimmed away in the middle: a token with a stray newline produces a header
 * the endpoint answers with 401, which reads like a wrong key instead of a
 * broken paste.
 */
function cleanKey(value) {
  if (typeof value !== 'string') return ''
  const key = value.trim()
  if (key.length === 0 || key.length > 200) return ''
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return ''
  return key
}

/**
 * Persist a key next to the data. Written 0600 at creation and chmod'ed after,
 * because an existing file keeps its old mode and a world-readable secret is
 * worse than no convenience at all.
 */
export function writeKey(value) {
  const key = cleanKey(value)
  if (key.length === 0) throw new Error('key is empty or contains whitespace')
  mkdirSync(HOME + '/memory', { recursive: true })
  writeFileSync(KEY_FILE, key + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(KEY_FILE, 0o600)
  return { source: keySource() }
}

/** Forget the stored key. A DSH_MEMORY_API_KEY in the environment still applies. */
export function clearKey() {
  try {
    unlinkSync(KEY_FILE)
  } catch {
    // nothing stored: clearing twice is not an error
  }
  return { source: keySource() }
}

export const KEY_PATH = KEY_FILE
export const CONFIG_PATH = CONFIG_FILE
export const STATS_PATH = STATS_FILE
export const MODEL_FALLBACK = MODEL_DEFAULT

/** Thinking is a three-way choice: let the endpoint decide, force on, force off. */
const THINKING = ['auto', 'enabled', 'disabled']

/** Current settings, defaulted rather than throwing on a damaged file. */
export function readConfig() {
  let parsed = {}
  try {
    parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    parsed = {}
  }
  const doc = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  return {
    model: typeof doc.model === 'string' && doc.model.trim().length > 0 ? doc.model.trim().slice(0, 60) : MODEL_DEFAULT,
    thinking: THINKING.includes(doc.thinking) ? doc.thinking : 'auto'
  }
}

/** Merge a patch into the settings and persist it. */
export function writeConfig(patch) {
  const next = { ...readConfig() }
  if (typeof patch.model === 'string' && patch.model.trim().length > 0) next.model = patch.model.trim().slice(0, 60)
  if (THINKING.includes(patch.thinking)) next.thinking = patch.thinking
  mkdirSync(HOME + '/memory', { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** Rolling latency counters, so the panel can show what memory actually costs. */
export function readStats() {
  let parsed = {}
  try {
    parsed = JSON.parse(readFileSync(STATS_FILE, 'utf8'))
  } catch {
    parsed = {}
  }
  const doc = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const rawKinds = doc.byKind !== null && typeof doc.byKind === 'object' && !Array.isArray(doc.byKind) ? doc.byKind : {}
  const byKind = {}
  for (const key of Object.keys(rawKinds)) {
    const slot = rawKinds[key]
    if (slot === null || typeof slot !== 'object') continue
    const calls = typeof slot.calls === 'number' && Number.isFinite(slot.calls) ? slot.calls : 0
    const totalMs = typeof slot.totalMs === 'number' && Number.isFinite(slot.totalMs) ? slot.totalMs : 0
    byKind[key] = { calls, totalMs, avgMs: calls > 0 ? Math.round(totalMs / calls) : 0 }
  }
  const calls = typeof doc.calls === 'number' && Number.isFinite(doc.calls) ? doc.calls : 0
  const totalMs = typeof doc.totalMs === 'number' && Number.isFinite(doc.totalMs) ? doc.totalMs : 0
  return {
    calls,
    totalMs,
    avgMs: calls > 0 ? Math.round(totalMs / calls) : 0,
    lastMs: typeof doc.lastMs === 'number' ? doc.lastMs : 0,
    at: typeof doc.at === 'string' ? doc.at : '',
    byKind
  }
}

/** Record one call's duration. A failure here must never disturb a turn. */
function recordStat(kind, ms) {
  try {
    const stats = readStats()
    const slot = stats.byKind[kind] !== undefined ? stats.byKind[kind] : { calls: 0, totalMs: 0, avgMs: 0 }
    stats.byKind[kind] = { calls: slot.calls + 1, totalMs: slot.totalMs + ms, avgMs: 0 }
    mkdirSync(HOME + '/memory', { recursive: true })
    writeFileSync(STATS_FILE, JSON.stringify({
      calls: stats.calls + 1,
      totalMs: stats.totalMs + ms,
      lastMs: ms,
      at: new Date().toISOString(),
      byKind: stats.byKind
    }, null, 2) + '\n', 'utf8')
  } catch {
    // A missing statistics file only costs a chart, not a memory.
  }
}

/**
 * One chat completion. `json` asks for a JSON object and falls back to prompt-only
 * JSON when that parameter is rejected. `kind` names the counter bucket so the
 * panel can show what each part of the pipeline actually costs.
 */
async function chat(system, user, options) {
  const settings = readConfig()
  const timeoutMs = options !== undefined && typeof options.timeoutMs === 'number' ? options.timeoutMs : 30000
  const json = options === undefined || options.json !== false
  const kind = options !== undefined && typeof options.kind === 'string' ? options.kind : 'chat'
  const key = apiKey()
  if (key.length === 0) throw new Error('memory model key missing: put it in ' + KEY_FILE + ' or DSH_MEMORY_API_KEY')

  const body = {
    model: settings.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: 1600,
    temperature: 0.2,
    stream: false
  }
  if (json) body.response_format = { type: 'json_object' }
  // Only explicit overrides are sent; "auto" leaves the endpoint's own default.
  // `forceThinkingDisabled` exists because one request shape — a large memory digest
  // plus a constrained JSON response — reproducibly degenerated into a run of
  // whitespace that still reported finish_reason "stop". The same request with
  // thinking off returned clean JSON, so that is the retry path.
  if (options !== undefined && options.forceThinkingDisabled === true) body.thinking = { type: 'disabled' }
  else if (settings.thinking === 'disabled') body.thinking = { type: 'disabled' }
  else if (settings.thinking === 'enabled') body.thinking = { type: 'enabled' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const elapsed = Date.now() - started
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300)
      // A rejected optional field is worth one retry without it; anything else
      // (auth, quota, model gone) is a real failure.
      if (/response_format|thinking|unsupported/i.test(text) && (json || body.thinking !== undefined)) {
        return chat(system, user, { ...options, json: false })
      }
      recordStat(kind + ':error', elapsed)
      throw new Error('memory model HTTP ' + response.status + ': ' + text)
    }
    const payload = await response.json()
    recordStat(kind, elapsed)
    const message = payload && payload.choices && payload.choices[0] ? payload.choices[0].message : undefined
    return {
      content: message === undefined ? '' : String(message.content ?? ''),
      usage: payload === undefined || payload === null ? null : payload.usage ?? null,
      elapsed
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Pull the first balanced JSON object out of a possibly chatty reply. */
export function extractJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const ORGANISE_SYSTEM = `你是记忆整理器，为另一个 AI 维护长期记忆。你不和用户对话，也不指导主模型做事。

任务：把主模型这一轮"做了什么"压成 0~3 条以后还用得上的记忆。

规则：
- 只记结论、坑、决定、明确的下一步。过程流水、寒暄、情绪不要记。
- 每条不超过 120 字，要具体到能直接执行：文件名、参数、数值、报错原文。
- 与"已有记忆"重复的不要新增；发现已有条目被推翻或该合并，把它的 id 放进 hide。
- 没有值得记的就给空数组 notes。不要为了填满而凑数。
- 不要复述用户说了什么，除非那是决定。

只输出 JSON：
{"notes":[{"text":"...","topic":"不超过12字","kind":"lesson|note|rant"}],"hide":[1],"why":"一句话说明为什么这样整理"}`

const CONSOLIDATE_SYSTEM = `你是深度整理器，维护一个 AI 的长期重要记忆。

任务：把"新情况"和"已有的重要记忆"合并成一份更短、更准、更结构化的文档。

规则：
- 保留所有仍然成立的事实、数值、结论；丢掉已被推翻或明显过时的。
- 如果新情况推翻了旧结论，在文档里明确写「（已推翻：旧说法 → 新说法）」，不要悄悄改掉。
- 1200 字以内，分小节，最关键的写在最前面。
- 不加评论、不客套、不说"好的"。

只输出 JSON：
{"title":"不超过10字的分节标题","text":"合并后的正文","superseded":["被推翻的旧说法"]}`

const CONVERSE_SYSTEM = `你是这个 AI 的记忆管家，正在和一个真人聊天。你唯一的话题是"它记住了什么"。

说话方式：口语化、简短、像同事之间讲话。不要列长清单，不要有"作为记忆管家"这种腔调。

只能依据下面的「当前记忆」回答，不要编造没写的东西。记忆里没有就直说没有。

改动的规矩（最重要）：
- 用户只是问、想了解，就正常回答，change 给 null。
- 用户要求改、删、纠正、合并任何记忆时，如果他没有给出理由，change **必须**给 null，
  并且要用口语问一句为什么——像"行，不过我得先问一句，为啥要动这条？"。
- 只有用户给出了理由，才可以返回 change，并把理由写进 reason。
- 不确定要改哪一条就先问清楚，不要猜。
- 用户给出理由之后，你还要判断这个理由站不站得住：理由是否具体、真实；被改的那条记忆
  是不是真的该按他说的改（有没有保存价值，会不会丢掉关键信息）。敷衍的说法不算理由——
  "删掉吧""没用""随手删""理由：删除"这类，一律拒绝。站不住时 change 必须给 null，
  reply 必须以「我拒绝修改」开头，后面可以跟一句口语化的原因。
- 记忆里标了〔密钥保护〕的条目，授权归宿主核对，**你不要自己判断理由真假**：
  照常返回 change，宿主会逐字比对密钥，不匹配就拦下来。你既不要放水，也不要替宿主拒绝。
- 只有理由通过判断、且密钥（若有）由宿主核对通过，改动才会真的发生。
- 你在等理由的时候，必须把 needs_reason 设成 true（面板靠它弹理由输入框）；
  正常回答或已经拿到理由时设成 false。

只输出 JSON：
{"reply":"你要说的话","change":null,"needs_reason":false}
或
{"reply":"你要说的话","change":null,"needs_reason":true}
或
{"reply":"你要说的话","change":{"action":"hide","ids":[3,7],"reason":"用户给的理由"},"needs_reason":false}
或
{"reply":"你要说的话","change":{"action":"write","scope":"world|topic:名|file:路径","slot":"小写名","title":"显示名","text":"新正文","reason":"用户给的理由"},"needs_reason":false}`

/**
 * Turn one turn's digest into level-1 notes.
 * @returns `{ notes, hide, why, usage, elapsed }`, defensively shaped.
 */
export async function organise(input) {
  const existing = input.existing.length === 0
    ? '（无）'
    : input.existing.map((entry) => '#' + entry.id + ' [' + (entry.topic || '无题') + '] ' + entry.text).join('\n')
  const user = ['作用域：' + input.scope, '', '已有记忆：', existing, '', '主模型这一轮做了什么：', input.summary].join('\n')
  const { content, usage, elapsed } = await chat(ORGANISE_SYSTEM, user, { kind: 'organise' })
  const parsed = extractJson(content)
  if (parsed === null) return { notes: [], hide: [], why: '整理器没有返回可解析的 JSON', usage, elapsed, raw: content.slice(0, 400) }
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes
      .filter((note) => note !== null && typeof note === 'object' && typeof note.text === 'string' && note.text.trim().length > 0)
      .slice(0, 3)
      .map((note) => ({
        text: String(note.text).trim().slice(0, 2000),
        topic: typeof note.topic === 'string' ? note.topic.trim().slice(0, 24) : '',
        kind: ['lesson', 'note', 'rant'].includes(note.kind) ? note.kind : 'note'
      }))
    : []
  const hide = Array.isArray(parsed.hide) ? parsed.hide.filter((id) => typeof id === 'number' && Number.isFinite(id)) : []
  return { notes, hide, why: typeof parsed.why === 'string' ? parsed.why.slice(0, 200) : '', usage, elapsed }
}

/**
 * Consolidate something important into one level-2 document.
 * @returns `{ title, text, superseded, usage, elapsed }`.
 */
export async function consolidate(input) {
  const existing = input.existing.length === 0
    ? '（无）'
    : input.existing.map((doc) => '· ' + doc.slot + '：' + doc.text).join('\n\n')
  const user = ['作用域：' + input.scope, '', '已有重要记忆：', existing, '', '新情况：', input.text].join('\n')
  const { content, usage, elapsed } = await chat(CONSOLIDATE_SYSTEM, user, { kind: 'consolidate' })
  const parsed = extractJson(content)
  if (parsed === null) throw new Error('整理器没有返回可解析的 JSON：' + content.slice(0, 200))
  return {
    title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 40) : '',
    text: typeof parsed.text === 'string' ? parsed.text.trim().slice(0, 4000) : '',
    superseded: Array.isArray(parsed.superseded) ? parsed.superseded.filter((s) => typeof s === 'string').slice(0, 20) : [],
    usage,
    elapsed
  }
}

/** Validate a change proposal into the only shapes the host will apply. */
function normaliseChange(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const action = raw.action === 'hide' || raw.action === 'write' ? raw.action : null
  if (action === null) return null
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 500) : ''
  if (action === 'hide') {
    const ids = Array.isArray(raw.ids) ? raw.ids.filter((id) => typeof id === 'number' && Number.isFinite(id)) : []
    return ids.length === 0 ? null : { action: 'hide', ids, reason }
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const slot = typeof raw.slot === 'string' ? raw.slot.trim() : ''
  if (text.length === 0 || slot.length === 0) return null
  return {
    action: 'write',
    scope: typeof raw.scope === 'string' ? raw.scope.trim() : 'world',
    slot,
    title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 40) : '',
    text: text.slice(0, 4000),
    reason
  }
}

/**
 * Answer a person's question about memory, and only allow a change when they gave
 * a reason. The gate is enforced here as well as in the prompt: a proposal without
 * a reason is dropped whatever the model returns.
 */
export async function converse(input) {
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : ''
  const build = (digest) => [
    '当前记忆：',
    digest,
    '',
    '用户说：',
    input.message,
    '',
    reason.length > 0 ? '用户给出的修改理由：' + reason : '用户没有给出修改理由。'
  ].join('\n')

  // The digest is capped: a very large one is what tipped the model into degenerate
  // whitespace, and a chat only needs the headline of each record anyway.
  const first = await chat(CONVERSE_SYSTEM, build(String(input.digest).slice(0, 4000)), { kind: 'converse', timeoutMs: 45000 })
  let content = first.content
  let elapsed = first.elapsed
  let parsed = extractJson(content)

  if (parsed === null && String(content).trim().length === 0) {
    // Degenerate reply. Retry smaller and with thinking forced off — measured clean.
    const retry = await chat(CONVERSE_SYSTEM, build(String(input.digest).slice(0, 2000)), {
      kind: 'converse:retry',
      timeoutMs: 45000,
      forceThinkingDisabled: true
    })
    content = retry.content
    elapsed += retry.elapsed
    parsed = extractJson(content)
  }

  if (parsed === null) {
    const prose = String(content).trim().slice(0, 1500)
    return {
      reply: prose.length > 0 ? prose : '（记忆模型连续两次返回空白内容——已重试并关闭思考，仍然为空。这不是你的问题。）',
      change: null,
      blocked: false,
      elapsed
    }
  }
  const proposed = normaliseChange(parsed.change)
  return {
    reply: typeof parsed.reply === 'string' && parsed.reply.trim().length > 0 ? parsed.reply.trim().slice(0, 2000) : '（没有回答）',
    change: reason.length > 0 ? proposed : null,
    // Two ways the panel learns it must ask for a reason: the model flagged it, or
    // it tried to propose a change while no reason was supplied (dropped here).
    blocked: reason.length === 0 && (parsed.needs_reason === true || proposed !== null),
    elapsed
  }
}
