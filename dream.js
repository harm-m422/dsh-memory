/**
 * 标准版做梦：两种，性质完全不同。
 *
 * 1) 整理梦（tidy）：记忆文件自己总结、自己重排。
 *    索引是派生物（dream/index.jsonl + terms.json + timeline.md），原件保持可用；
 *    合并重复时才会重写 entries.jsonl——writeEntries 自带 .bak 和原子替换，
 *    看不动的行原样带过去，退下来的原文进 dream/merged.jsonl。
 *    频率：每周掷色子至少两次，和 ACC 同一套账（欠几次 / 还剩几天）。
 *
 * 2) 练习梦（practice）：模型给自己出题，按记忆回答，在模拟里积累经验。
 *    每 10 天一次；只在「不在上班时段、机器闲着、harness 不在前台」时开始。
 *    上班时段 = 北京时间周一至周五（法定节假日除外，调休上班日算工作日）
 *    09:00–12:00、14:00–18:00。
 *    预算：一次练习梦最多 200 万 token，按调用返回的 usage 累加，超了就停。
 *    产物单独存（experience.jsonl），每轮最多注入 2 条——练手学来的东西
 *    不是事实，不能混进真实记忆。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cpus, loadavg } from 'node:os'
import { isSealed } from './vault.js'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const BEIJING = 8 * HOUR

const TIDY_PER_WEEK = 2
const TIDY_MIN_GAP = 8 * HOUR
const PRACTICE_EVERY_DAYS = 10
const PRACTICE_BUDGET = 2000000
const PRACTICE_MAX_TASKS = 3
const LOAD_CEILING = 0.5
const IDLE_MS = 5 * 60 * 1000
const TICK_MS = 5 * 60 * 1000

// 2026 年部分节假日安排（国办发明电〔2025〕7 号，2025-11-04）。
// 调休上班日单独列出：那是周六周日，但要上班，按工作日算。
const HOLIDAYS_2026 = {
  year: 2026,
  holidays: [
    '01-01', '01-02', '01-03',
    '02-15', '02-16', '02-17', '02-18', '02-19', '02-20', '02-21', '02-22', '02-23',
    '04-04', '04-05', '04-06',
    '05-01', '05-02', '05-03', '05-04', '05-05',
    '06-19', '06-20', '06-21',
    '09-25', '09-26', '09-27',
    '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07'
  ],
  workdays: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10']
}
const HOLIDAY_TABLE = HOLIDAYS_2026

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 北京时间的日历字段，不依赖进程 TZ。 */
export function beijingParts(ts) {
  const d = new Date(ts + BEIJING)
  return {
    year: d.getUTCFullYear(),
    month: pad2(d.getUTCMonth() + 1),
    day: pad2(d.getUTCDate()),
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
  }
}

export function holidayOf(year, dir) {
  if (dir !== undefined) {
    try {
      const own = JSON.parse(readFileSync(join(dir, 'holidays.json'), 'utf8'))
      if (own !== null && typeof own === 'object' && own.year === year && Array.isArray(own.holidays)) {
        return { year, holidays: own.holidays.map(String), workdays: Array.isArray(own.workdays) ? own.workdays.map(String) : [] }
      }
    } catch { /* 没有自己的表就用内置的 */ }
  }
  return HOLIDAY_TABLE.year === year ? HOLIDAY_TABLE : null
}

/** 法定节假日或普通周末（调休上班日不算）。 */
export function isRestDay(ts, dir) {
  const p = beijingParts(ts)
  const key = p.month + '-' + p.day
  const table = holidayOf(p.year, dir)
  if (table !== null && table.workdays.includes(key)) return false
  if (table !== null && table.holidays.includes(key)) return true
  return p.weekday === 0 || p.weekday === 6
}

/** 上班时段：北京时间工作日 09:00–12:00、14:00–18:00。 */
export function inWorkBlock(ts, dir) {
  if (isRestDay(ts, dir)) return false
  const { minutes } = beijingParts(ts)
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

function weekWindow(ts) {
  const p = beijingParts(ts)
  const start = new Date(ts + BEIJING)
  const shift = (start.getUTCDay() + 6) % 7
  const monday = Date.UTC(p.year, start.getUTCMonth(), start.getUTCDate()) - shift * DAY
  return { label: p.year + '-W' + pad2(isoWeek(ts)), start: monday - BEIJING, end: monday - BEIJING + 7 * DAY }
}

function isoWeek(ts) {
  const d = new Date(ts + BEIJING)
  const probe = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  probe.setUTCDate(probe.getUTCDate() + 4 - (probe.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(probe.getUTCFullYear(), 0, 1))
  return Math.ceil(((probe - yearStart) / 86400000 + 1) / 7)
}

function readJson(path, blank) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : blank
  } catch {
    return blank
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
  } catch { /* 写不进去不影响主流程 */ }
}

function charGrams(text) {
  const clean = String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '')
  const out = new Set()
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

/** 一行有没有根：和原材料共享足够多的字符二元组。 */
function groundedLine(line, pool) {
  const grams = charGrams(line)
  if (grams.size === 0) return false
  let hit = 0
  for (const gram of grams) if (pool.has(gram)) hit += 1
  return hit >= Math.max(2, Math.ceil(grams.size * 0.34))
}

function parseJsonReply(raw) {
  const text = String(raw ?? '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    const parsed = JSON.parse(text.slice(first, last + 1))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : value.slice(0, max - 1) + '…'
}

export function installDream(ctx, deps) {
  const dir = deps.dir
  const readEntries = deps.readEntries
  const writeEntries = deps.writeEntries
  const llm = deps.llm
  const log = deps.log

  const root = join(dir, 'dream')
  const configPath = join(dir, 'dream.json')
  const statePath = join(dir, 'dream-state.json')
  const experiencePath = join(root, 'experience.jsonl')

  let lastActive = Date.now()
  let busy = false
  // 撞到过要登录/无权限的 provider：这一次运行里就别再试它了，否则每道题
  // 都要多等一次注定失败的往返。
  const deadProviders = new Set()

  function config() {
    const raw = readJson(configPath, {})
    const tidy = raw.tidy !== null && typeof raw.tidy === 'object' ? raw.tidy : {}
    const practice = raw.practice !== null && typeof raw.practice === 'object' ? raw.practice : {}
    return {
      tidy: {
        enabled: tidy.enabled !== false,
        perWeek: Number.isFinite(Number(tidy.perWeek)) ? Math.max(1, Math.min(7, Math.floor(Number(tidy.perWeek)))) : TIDY_PER_WEEK
      },
      practice: {
        enabled: practice.enabled !== false,
        everyDays: Number.isFinite(Number(practice.everyDays)) ? Math.max(1, Math.floor(Number(practice.everyDays))) : PRACTICE_EVERY_DAYS,
        budget: Number.isFinite(Number(practice.budget)) ? Math.max(100, Math.floor(Number(practice.budget))) : PRACTICE_BUDGET
      },
      inject: Number.isFinite(Number(raw.inject)) ? Math.max(0, Math.min(3, Math.floor(Number(raw.inject)))) : 2,
      loadCeiling: Number.isFinite(Number(raw.loadCeiling)) ? Number(raw.loadCeiling) : LOAD_CEILING,
      provider: typeof raw.provider === 'string' ? raw.provider : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      // 默认低推理：这个模型默认会把 token 全花在思考上，写代码题直接撞上限。
      // 只认 'off' / 'low' / 'high'，填错就退回不指定（见 ask 的两档重试）。
      effort: typeof raw.effort === 'string' && raw.effort.length > 0 ? raw.effort : 'low'
    }
  }

  function state() {
    const raw = readJson(statePath, {})
    const tidy = raw.tidy !== null && typeof raw.tidy === 'object' ? raw.tidy : {}
    const practice = raw.practice !== null && typeof raw.practice === 'object' ? raw.practice : {}
    return {
      tidy: {
        week: typeof tidy.week === 'string' ? tidy.week : '',
        count: typeof tidy.count === 'number' ? tidy.count : 0,
        carry: tidy.carry === 1 ? 1 : 0,
        rolledDay: typeof tidy.rolledDay === 'string' ? tidy.rolledDay : '',
        fireAt: typeof tidy.fireAt === 'number' ? tidy.fireAt : 0,
        lastAt: typeof tidy.lastAt === 'string' ? tidy.lastAt : '',
        failures: typeof tidy.failures === 'number' ? tidy.failures : 0,
        lastError: typeof tidy.lastError === 'string' ? tidy.lastError : ''
      },
      practice: {
        nextAt: typeof practice.nextAt === 'number' ? practice.nextAt : 0,
        lastAt: typeof practice.lastAt === 'string' ? practice.lastAt : '',
        spent: typeof practice.spent === 'number' ? practice.spent : 0,
        failures: typeof practice.failures === 'number' ? practice.failures : 0,
        lastError: typeof practice.lastError === 'string' ? practice.lastError : '',
        lastSummary: typeof practice.lastSummary === 'string' ? practice.lastSummary : ''
      }
    }
  }

  function saveState(next) {
    writeJson(statePath, next)
    return next
  }

  // ── 模型 ───────────────────────────────────────────────────────────────────
  async function ask(system, user, maxTokens) {
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') throw new Error('harness 没有提供 llm 服务')
    const cfg = config()
    let providers = []
    try {
      providers = (typeof llm.listProviders === 'function' ? llm.listProviders() : [])
        .map(function (one) { return one !== null && typeof one === 'object' ? one.id : undefined })
        .filter(function (id) { return typeof id === 'string' && id.length > 0 })
    } catch { providers = [] }
    // provider 列表里可能有本地模型服务（local-qwen）和要登录的 account。
    // 直接把 deepseek-flash 发给 local-qwen 就是 UNKNOWN_MODEL，所以先问一遍
    // 每个 provider 到底有哪些模型，再挑一个它真有的。
    const modelCache = (globalThis[Symbol.for('dsh.memory.dream.models')] ??= new Map())
    async function modelsOf(provider) {
      const hit = modelCache.get(provider)
      if (hit !== undefined && Date.now() - hit.at < 600000) return hit.ids
      let ids = []
      try {
        const list = typeof llm.listModels === 'function' ? await llm.listModels(provider) : []
        ids = (Array.isArray(list) ? list : [])
          .map(function (one) { return one !== null && typeof one === 'object' ? one.id : undefined })
          .filter(function (id) { return typeof id === 'string' && id.length > 0 })
      } catch { ids = [] }
      modelCache.set(provider, { at: Date.now(), ids })
      return ids
    }
    function pickModel(ids) {
      if (ids.length === 0) return ''
      if (cfg.model.length > 0 && ids.includes(cfg.model)) return cfg.model
      const flash = ids.find(function (id) { return /flash|chat|instruct/i.test(id) })
      return flash !== undefined ? flash : ids[0]
    }
    const candidates = []
    function push(provider, model) {
      if (typeof provider !== 'string' || provider.length === 0) return
      if (typeof model !== 'string' || model.length === 0) return
      if (candidates.some(function (one) { return one.provider === provider && one.model === model })) return
      candidates.push({ provider, model })
    }
    // 排序：official → 其它 deepseek → 本地/第三方 → account（要登录，最后再试）
    const rank = function (id) {
      if (/official/.test(id)) return 0
      if (/deepseek/.test(id)) return 1
      if (/account/.test(id)) return 3
      return 2
    }
    const ordered = providers.slice().sort(function (a, b) { return rank(a) - rank(b) })
    if (cfg.provider.length > 0 && cfg.model.length > 0) push(cfg.provider, cfg.model)
    for (const id of ordered) {
      if (deadProviders.has(id)) continue
      const ids = await modelsOf(id)
      const model = pickModel(ids)
      if (model.length === 0) {
        // 目录问不到（离线/不支持）：仍按默认名试一次，真不行下一个候选会接住
        if (providers.length <= 1) push(id, cfg.model.length > 0 ? cfg.model : 'deepseek-flash')
        continue
      }
      push(id, model)
    }
    if (candidates.length === 0) push('deepseek-official', cfg.model.length > 0 ? cfg.model : 'deepseek-flash')

    // 两档：先按配置的 effort；这个 provider 不认就退成不指定。
    const efforts = [cfg.effort, null]

    let lastError = null
    // 空回复有一半是偶发的：同一组候选再试一圈，别让一次空手白跑十天。
    for (let round = 0; round < 2; round += 1) {
      for (const effort of efforts) {
      for (const candidate of candidates) {
        try {
          const said = []
          const kinds = {}
          let finish = ''
          let usage = 0
          const request = {
            provider: candidate.provider,
            model: candidate.model,
            messages: [{ role: 'user', content: [{ type: 'text', text: system + '\n\n' + user }] }],
            maxTokens
          }
          if (effort !== null) request.reasoningEffort = effort
          for await (const chunk of llm.stream(request)) {
            if (chunk === null || typeof chunk !== 'object') continue
            kinds[String(chunk.type)] = (kinds[String(chunk.type)] ?? 0) + 1
            if (chunk.type === 'text-delta') said.push(String(chunk.text ?? ''))
            if (chunk.type === 'finish') finish = typeof chunk.reason === 'string' ? chunk.reason : JSON.stringify(chunk.reason ?? '')
            if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
              usage += Number(chunk.usage.totalTokens ?? (Number(chunk.usage.inputTokens ?? 0) + Number(chunk.usage.outputTokens ?? 0))) || 0
            }
          }
          const text = said.join('').trim()
          if (text.length === 0) {
            const seen = Object.keys(kinds).map(function (kind) { return kind + '×' + kinds[kind] }).join(',')
            throw new Error('模型没有返回正文（收到：' + (seen.length > 0 ? seen : '什么也没有')
              + (finish.length > 0 ? '，结束原因 ' + finish : '') + '）')
          }
          return { text, usage, provider: candidate.provider, model: candidate.model, effort }
        } catch (error) {
          lastError = error
          const text = String(error?.message ?? error)
          if (text.includes('ACCOUNT_SIGN_IN_REQUIRED') || text.includes('must allow account authentication')) {
            deadProviders.add(candidate.provider)
          }
        }
      }
      }
      if (round === 0) await new Promise(function (resolve) { setTimeout(resolve, 1200) })
    }
    throw new Error('叫不动模型：' + String(lastError === null ? '没有可用的 provider' : lastError.message))
  }

  // ── 整理梦 ─────────────────────────────────────────────────────────────────
  function entriesView() {
    const entries = readEntries()
    const out = []
    for (const entry of entries) {
      const text = typeof entry.text === 'string' ? entry.text : ''
      if (text.length === 0) continue
      out.push({
        id: entry.id,
        at: String(entry.at ?? ''),
        scope: typeof entry.scope === 'string' ? entry.scope : 'world',
        kind: typeof entry.kind === 'string' ? entry.kind : 'note',
        tier: typeof entry.tier === 'string' ? entry.tier : '',
        text
      })
    }
    return out
  }

  function digestOf(text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
    const cut = clean.search(/[。！？!?]\s*/)
    const head = cut > 0 && cut < 80 ? clean.slice(0, cut) : clean
    return head.slice(0, 60)
  }

  /**
   * 重建索引：一行一条的 jsonl + 词倒排 + 字节偏移 + 人能读的 timeline.md。
   *
   * 直接读 entries.jsonl 的原文，不走 readEntries：一来省一次全量解析，二来
   * 密文条目不能被解出明文再写进索引（摘要一旦落盘就是明文泄漏）。加密条目只
   * 记「（加密条目）」，不建词条。
   */
  function rebuildIndex() {
    mkdirSync(root, { recursive: true })
    const path = join(dir, 'entries.jsonl')
    let raw = ''
    try { raw = readFileSync(path, 'utf8') } catch { raw = '' }
    const rows = []
    const terms = new Map()
    let sealed = 0
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let entry = null
      try { entry = JSON.parse(trimmed) } catch { entry = null }
      const id = entry !== null && typeof entry === 'object' ? entry.id : undefined
      if (typeof id !== 'number') continue
      // 密文条目的 text 是对象（{enc,iv,tag,data}），不是字符串：先判 isSealed，
      // 别先被 typeof 过滤成空串——那样加密条目会在时间线里变成空白行，还数不进 sealed。
      const rawText = entry.text
      const hidden = isSealed(rawText)
      if (hidden) sealed += 1
      const digest = hidden ? '（加密条目）' : digestOf(typeof rawText === 'string' ? rawText : '')
      rows.push({
        id,
        at: String(entry.at ?? ''),
        scope: typeof entry.scope === 'string' ? entry.scope : 'world',
        kind: typeof entry.kind === 'string' ? entry.kind : 'note',
        tier: typeof entry.tier === 'string' ? entry.tier : '',
        digest
      })
      if (hidden) continue
      const seen = new Set()
      for (const gram of charGrams(digest)) {
        if (seen.has(gram)) continue
        seen.add(gram)
        const list = terms.get(gram)
        if (list === undefined) terms.set(gram, [id])
        else if (list.length < 400) list.push(id)
      }
    }
    writeFileSync(join(root, 'index.jsonl'), rows.map(function (row) { return JSON.stringify(row) }).join('\n') + '\n', 'utf8')
    writeFileSync(join(root, 'terms.json'), JSON.stringify({ builtAt: new Date().toISOString(), terms: Object.fromEntries(terms) }), 'utf8')
    writeJson(join(root, 'stats.json'), { builtAt: new Date().toISOString(), entries: rows.length, sealed })

    const byScope = new Map()
    for (const row of rows) {
      const key = row.scope
      const list = byScope.get(key)
      if (list === undefined) byScope.set(key, [row])
      else list.push(row)
    }
    const lines = ['# 记忆时间线', '', '由整理梦重建，' + new Date().toISOString() + '，共 ' + rows.length + ' 条。', '']
    for (const key of Array.from(byScope.keys()).sort()) {
      lines.push('## ' + key, '')
      for (const row of byScope.get(key).slice(-200)) {
        lines.push('- ' + row.at.slice(0, 10) + ' · #' + row.id + ' · ' + row.digest)
      }
      lines.push('')
    }
    writeFileSync(join(root, 'timeline.md'), lines.join('\n'), 'utf8')
    return { entries: rows.length, terms: terms.size }
  }

  /** 索引搜索：给几个词，拿回 id。索引没有就返回 null，让调用方走老路。 */
  function searchIndex(query, limit) {
    let index = null
    try { index = JSON.parse(readFileSync(join(root, 'terms.json'), 'utf8')) } catch { return null }
    if (index === null || typeof index !== 'object' || index.terms === null || typeof index.terms !== 'object') return null
    const words = charGrams(String(query ?? ''))
    if (words.size === 0) return []
    const score = new Map()
    for (const gram of words) {
      const ids = index.terms[gram]
      if (!Array.isArray(ids)) continue
      for (const id of ids) score.set(id, (score.get(id) ?? 0) + 1)
    }
    return Array.from(score.entries())
      .sort(function (a, b) { return b[1] - a[1] || b[0] - a[0] })
      .slice(0, limit === undefined ? 20 : limit)
      .map(function (pair) { return { id: pair[0], score: pair[1] } })
  }

  /** 合并重复：只在同 scope、词重合度高的组里动手；合并结果必须自己也有根。 */
  async function mergeDuplicates(entries) {
    const groups = new Map()
    for (const entry of entries) {
      const key = entry.scope + '\u0000' + entry.kind
      const list = groups.get(key)
      if (list === undefined) groups.set(key, [entry])
      else list.push(entry)
    }
    const candidates = []
    for (const list of groups.values()) {
      if (list.length < 4) continue
      const grams = list.map(function (entry) { return charGrams(digestOf(entry.text)) })
      const used = new Set()
      for (let i = 0; i < list.length; i += 1) {
        if (used.has(i)) continue
        const cluster = [i]
        for (let j = i + 1; j < list.length; j += 1) {
          if (used.has(j)) continue
          let hit = 0
          for (const gram of grams[i]) if (grams[j].has(gram)) hit += 1
          if (grams[i].size > 0 && hit / grams[i].size >= 0.45) { cluster.push(j); used.add(j) }
        }
        if (cluster.length >= 2) { used.add(i); candidates.push(cluster.map(function (k) { return list[k] })) }
      }
    }
    if (candidates.length === 0) return { merged: 0, groups: 0 }
    const material = candidates.slice(0, 20).map(function (cluster, index) {
      return '组 ' + (index + 1) + '（scope=' + cluster[0].scope + '）：\n' + cluster.map(function (entry) { return '- #' + entry.id + ' ' + clip(entry.text, 120) }).join('\n')
    }).join('\n\n')
    const system = [
      '你在整理自己的记忆日志。下面每组是同一个范围里说同一件事的几条记录。',
      '规则：',
      '1. 每组只输出一条合并后的记录，它必须同时覆盖原来的意思，不许加新内容。',
      '2. 每条不超过 80 字，用一句话写清楚。',
      '3. 拿不准就原样保留最长的那条。',
      '输出 JSON：{"groups":[{"merged":"...","ids":[1,2]}]}，只有 JSON。'
    ].join('\n')
    const reply = await ask(system, material, 2500)
    const parsed = parseJsonReply(reply.text)
    const kept = new Map()
    const mergedOut = []
    if (parsed !== null && Array.isArray(parsed.groups)) {
      for (const group of parsed.groups) {
        if (group === null || typeof group !== 'object') continue
        if (!Array.isArray(group.ids) || group.ids.length < 2) continue
        const ids = group.ids.filter(function (id) { return typeof id === 'number' })
        const members = []
        for (const id of ids) {
          const found = entries.find(function (entry) { return entry.id === id })
          if (found !== undefined) members.push(found)
        }
        if (members.length < 2) continue
        const pool = new Set()
        for (const member of members) for (const gram of charGrams(member.text)) pool.add(gram)
        const merged = clip(String(group.merged ?? ''), 80)
        if (merged.length < 4 || !groundedLine(merged, pool)) continue
        const oldest = members.reduce(function (a, b) { return (a.at ?? '') < (b.at ?? '') ? a : b })
        kept.set(oldest.id, merged)
        for (const member of members) {
          if (member.id === oldest.id) continue
          mergedOut.push({ at: new Date().toISOString(), id: member.id, scope: member.scope, text: member.text, into: oldest.id })
        }
        mergedOut.push({ at: new Date().toISOString(), id: oldest.id, scope: oldest.scope, text: members.map(function (m) { return m.text }).join(' ／ '), why: 'merged-into', merged })
      }
    }
    if (kept.size === 0) return { merged: 0, groups: candidates.length, usage: reply.usage, model: reply.model }

    const next = []
    let dropped = 0
    for (const entry of entries) {
      const merged = kept.get(entry.id)
      if (merged !== undefined) { next.push({ ...entry, text: merged }); continue }
      if (mergedOut.some(function (row) { return row.id === entry.id && row.into !== undefined })) { dropped += 1; continue }
      next.push(entry)
    }
    if (dropped > 0) writeEntries(next)
    if (mergedOut.length > 0) {
      mkdirSync(root, { recursive: true })
      appendFileSync(join(root, 'merged.jsonl'), mergedOut.map(function (row) { return JSON.stringify(row) }).join('\n') + '\n', 'utf8')
    }
    return { merged: kept.size, dropped, groups: candidates.length, usage: reply.usage, model: reply.model }
  }

  async function runTidy(manual) {
    if (busy) return { ok: false, error: '已经在做梦了' }
    busy = true
    const started = Date.now()
    const record = { at: new Date().toISOString(), kind: 'tidy', manual: manual === true, ok: true, steps: [], errors: [], usage: 0 }
    try {
      const entries = entriesView()
      const index = rebuildIndex()
      record.index = index
      record.steps.push('索引 ' + index.entries + ' 条 / ' + index.terms + ' 个词')
      try {
        const merged = await mergeDuplicates(entries)
        record.merge = merged
        record.usage += merged.usage ?? 0
        record.steps.push(merged.merged > 0 ? ('合并 ' + merged.merged + ' 组，去掉 ' + merged.dropped + ' 条') : '没有需要合并的重复')
        // 合并改了条目，索引必须跟着重建；不然后面的编号对不上真实日志。
        if (merged.merged > 0) {
          record.index = rebuildIndex()
          record.steps.push('索引重建 ' + record.index.entries + ' 条')
        }
      } catch (error) { record.errors.push('合并：' + String(error?.message ?? error)) }
    } catch (error) {
      record.ok = false
      record.errors.push(String(error?.message ?? error))
    } finally {
      busy = false
    }
    record.ms = Date.now() - started
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'last-tidy.json'), JSON.stringify(record, null, 2) + '\n', 'utf8')
    const next = state()
    const week = weekWindow(Date.now())
    if (record.ok) {
      const sameWeek = next.tidy.week === week.label
      next.tidy = {
        ...next.tidy,
        week: week.label,
        count: (sameWeek ? next.tidy.count : 0) + 1,
        lastAt: record.at,
        fireAt: 0,
        failures: 0,
        lastError: ''
      }
    } else {
      next.tidy = { ...next.tidy, fireAt: Date.now() + 2 * HOUR, failures: next.tidy.failures + 1, lastError: record.errors.join('；').slice(0, 300) }
    }
    saveState(next)
    return record
  }

  // ── 练习梦 ─────────────────────────────────────────────────────────────────
  function systemLoad() {
    const cores = Math.max(1, cpus().length)
    try { return loadavg()[0] / cores } catch { return 1 }
  }

  /** 现在能不能开始练习梦。返回 {ok, why}。 */
  function practiceGate(now) {
    const cfg = config()
    const st = state()
    if (!cfg.practice.enabled) return { ok: false, why: '练习梦关掉了' }
    if (busy) return { ok: false, why: '已经在做梦了' }
    if (now < st.practice.nextAt) return { ok: false, why: '还没到日子（' + new Date(st.practice.nextAt).toISOString().slice(0, 10) + '）' }
    if (inWorkBlock(now, dir)) return { ok: false, why: '上班时段不做（北京时间工作日 9–12 / 14–18）' }
    const load = systemLoad()
    if (load >= cfg.loadCeiling) return { ok: false, why: '机器正在忙（负载 ' + load.toFixed(2) + ' ≥ ' + cfg.loadCeiling + '）' }
    if (now - lastActive < IDLE_MS) return { ok: false, why: 'harness 刚还在用（' + Math.round((now - lastActive) / 1000) + ' 秒前）' }
    return { ok: true, why: '可以做' }
  }

  function readExperiences(limit) {
    try {
      const rows = readFileSync(experiencePath, 'utf8').split('\n')
        .filter(function (line) { return line.trim().length > 0 })
        .map(function (line) { try { return JSON.parse(line) } catch { return null } })
        .filter(function (row) { return row !== null && typeof row.text === 'string' })
      return rows.slice(-(limit === undefined ? 2 : limit))
    } catch { return [] }
  }

  function memoryPack() {
    const entries = entriesView()
    const world = entries.filter(function (entry) { return entry.scope === 'world' }).slice(-40)
    const rest = entries.filter(function (entry) { return entry.scope !== 'world' })
    const sample = []
    const pool = rest.slice()
    for (let i = 0; i < 12 && pool.length > 0; i += 1) {
      sample.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
    }
    const lines = []
    for (const entry of world.concat(sample)) {
      lines.push('#' + entry.id + ' [' + entry.scope + '] ' + clip(entry.text, 160))
    }
    return lines.join('\n')
  }

  /**
   * 只读工具的最小实现：模型在回答里写 <<read 路径>>，插件读回来喂给它。
   * 只能读工作区或记忆目录下的文件，单次 ≤8KB，不写、不执行。
   */
  function toolRead(path) {
    const wanted = String(path ?? '').trim()
    if (wanted.length === 0) return '（空路径）'
    const roots = [process.cwd(), dir]
    const absolute = wanted.startsWith('/') ? wanted : join(process.cwd(), wanted)
    const allowed = roots.some(function (root) { return absolute.startsWith(root.endsWith('/') ? root : root + '/') })
    if (!allowed) return '（不在只读许可范围：' + wanted + '）'
    try {
      const body = readFileSync(absolute, 'utf8')
      return body.length > 8192 ? body.slice(0, 8192) + '\n…（截断）' : body
    } catch (error) {
      return '（读不到：' + String(error?.message ?? error) + '）'
    }
  }

  async function runPractice(manual) {
    if (busy) return { ok: false, error: '已经在做梦了' }
    const now = Date.now()
    const gate = practiceGate(now)
    if (!gate.ok && manual !== true) return { ok: false, error: gate.why, gated: true }
    busy = true
    const started = Date.now()
    const cfg = config()
    const budget = cfg.practice.budget
    const record = { at: new Date().toISOString(), kind: 'practice', manual: manual === true, ok: true, tasks: [], spent: 0, errors: [], steps: [] }
    let spent = 0
    const stamp = record.at.replace(/[:.]/g, '-')
    try {
      // 1) 模型自己出题
      const system = [
        '你在给自己出练习。目的是检验：你对这个项目、这个人的记忆到底记住了多少。',
        '给你一段记忆日志。请出 ' + PRACTICE_MAX_TASKS + ' 道题，三选一：',
        'A. 从记忆里能回答的细节题（例如某个文件为什么那样改、某个结论的依据）。',
        'B. 一道需要把几条记忆拼起来才能答对的题。',
        'C. 一个很小的动手项目（不超过 80 行），必须用到真实记忆里的约束。',
        '题目要具体，不要"谈谈你对……的理解"这种。',
        '输出格式：一行一道题，三段用竖线隔开，不要编号，不要解释：',
        'A|题目文字|一句提示',
        'B|题目文字|',
        'C|题目文字|'
      ].join('\n')
      const plan = await ask(system, memoryPack() + '\n\n（只读工具：可以在回答里写 <<read 路径>> 读文件，最多两次。）', 2000)
      spent += plan.usage
      record.steps.push('出题 ' + Math.round(plan.usage) + ' tokens')
      const tasks = parseTasks(plan.text)
      if (tasks.length === 0) throw new Error('模型没给出可用的题：' + clip(plan.text, 160))

      // 2) 按记忆回答；C 类顺手把文件写进沙盒（只写不跑）
      const sandbox = join(root, 'sandbox', stamp)
      mkdirSync(sandbox, { recursive: true })
      for (let index = 0; index < tasks.length; index += 1) {
        if (spent >= budget) { record.steps.push('预算用完，剩下的题跳过'); break }
        const task = tasks[index]
        if (task === null || typeof task !== 'object') continue
        const question = String(task.question ?? '').trim()
        if (question.length === 0) continue
        const kind = String(task.type ?? 'A').slice(0, 1)
        let attempt
        try {
          attempt = await ask(
            [
              '你在梦里练习，只能依据下面的记忆回答，不许编。',
              '如果记忆里没有，就直说「记不清了」，并指出缺哪一条。',
              '需要看文件时写 <<read 路径>>，最多两次；不要写 <<write>>。',
              kind === 'C'
                ? '这道题要交一个小项目：先用两三句话写清方案，然后只输出一个 ``` 代码块，代码块第一行写文件名，别的都不要写。代码会写进沙盒，不会执行。'
                : '回答要具体，能落到文件、命令或结论上。'
            ].join('\n'),
            '记忆：\n' + memoryPack() + '\n\n题目：' + question,
            kind === 'C' ? 6000 : 2500
          )
        } catch (error) {
          // 一道题没答上来，不该把整次练习废掉
          record.errors.push('第 ' + (index + 1) + ' 题：' + String(error?.message ?? error))
          continue
        }
        spent += attempt.usage
        const reads = attempt.text.match(/<<read\s+([^>]+)>>/g) ?? []
        let toolOutput = ''
        for (const hit of reads.slice(0, 2)) {
          const path = hit.replace(/<<read\s+/, '').replace(/>>$/, '').trim()
          toolOutput += '\n[读 ' + path + ']\n' + toolRead(path)
        }
        let review = ''
        if (toolOutput.length > 0 && spent < budget) {
          const second = await ask(
            '这是你刚读到的内容。用一句话修正你刚才的回答，然后给出最终答案。',
            toolOutput + '\n\n你刚才的回答：\n' + attempt.text,
            1200
          )
          spent += second.usage
          review = second.text
        }
        // 交作业：写进沙盒，绝不执行。只有 C 类（写项目）才该落文件——
        // A/B 类回答里随手贴的 ``` 也会被当成作业，落一堆 30 字节的垃圾。
        const files = []
        if (kind === 'C') {
        const blockRe = /```([^\n`]*)\n([\s\S]*?)```/g
        let match = blockRe.exec(attempt.text)
        let blockIndex = 0
        while (match !== null) {
          blockIndex += 1
          const info = match[1].trim()
          const body = match[2]
          // 题目里点名了文件名（`run_test_plugin.sh`），就用它——比从代码块里猜准。
          const hinted = /[`"'（(]?([\w\-]+\.(?:sh|bash|py|js|mjs|ts|json|ya?ml|toml|md|txt))[`"')）]?/i.exec(question)
          const preferred = hinted === null ? '' : hinted[1]
          const name = blockIndex === 1 && preferred.length > 0 ? preferred : fileNameOf(info, body, blockIndex)
          try {
            writeFileSync(join(sandbox, name), body.slice(0, 20000), 'utf8')
            files.push(name)
          } catch { /* 沙盒写不进去就算了 */ }
          match = blockRe.exec(attempt.text)
        }
        }
        record.tasks.push({ type: kind, question: clip(question, 200), answer: clip(review.length > 0 ? review : attempt.text, 600), read: reads.length, files, tokens: Math.round(attempt.usage) })
      }

      // 3) 提炼经验（单独存，不进真实记忆）
      if (record.tasks.length === 0) throw new Error('一道题都没答上来，这次不算练过')
      try {
      if (spent < budget) {
        const lessons = await ask(
          [
            '把刚才这次练习里真正确认到的东西，提炼成 1-2 条以后能用的判断。',
            '写关于代码、配置、事实本身的结论；不要写「答题时应该先查某条」「要标缺失」这类答题过程。',
            '只写练习里真的验证过或真的缺了的东西；缺的就写「X 没有记录，需要补」，别猜。',
            '每条不超过 80 字，要能直接指导下一次动手。',
            '输出格式：一行一条，不要编号，不要解释，最多两条。'
          ].join('\n'),
          record.tasks.map(function (task) { return '题：' + task.question + '\n答：' + task.answer }).join('\n\n'),
          1200
        )
        spent += lessons.usage
        const list = parseLessons(lessons.text)
        const kept = []
        for (const item of list) {
          if (typeof item !== 'string') continue
          const line = clip(item, 80)
          if (line.length < 6) continue
          kept.push(line)
          if (kept.length >= 2) break
        }
        record.lessons = kept
        if (kept.length > 0) {
          mkdirSync(root, { recursive: true })
          appendFileSync(experiencePath, kept.map(function (line) {
            return JSON.stringify({ at: record.at, text: line, tags: ['practice'], run: stamp })
          }).join('\n') + '\n', 'utf8')
        }
      }
      } catch (error) {
        record.errors.push('经验：' + String(error?.message ?? error))
      }
    } catch (error) {
      record.ok = false
      record.errors.push(String(error?.message ?? error))
    } finally {
      busy = false
    }
    record.ms = Date.now() - started
    record.spent = Math.round(spent)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'last-practice.json'), JSON.stringify(record, null, 2) + '\n', 'utf8')
    const next = state()
    if (record.ok) {
      next.practice = {
        ...next.practice,
        lastAt: record.at,
        nextAt: Date.now() + cfg.practice.everyDays * DAY,
        spent: record.spent,
        failures: 0,
        lastError: '',
        lastSummary: (record.lessons ?? []).join('；')
      }
    } else {
      next.practice = {
        ...next.practice,
        lastAt: record.at,
        nextAt: Date.now() + 12 * HOUR,
        spent: record.spent,
        failures: next.practice.failures + 1,
        lastError: record.errors.join('；').slice(0, 300)
      }
    }
    saveState(next)
    return record
  }

  /** 出题结果：行格式 A|题目|提示；顺手兼容 JSON。 */
  function parseTasks(raw) {
    const out = []
    const json = parseJsonReply(raw)
    if (json !== null && Array.isArray(json.tasks)) {
      for (const task of json.tasks) {
        if (task === null || typeof task !== 'object') continue
        const question = String(task.question ?? '').trim()
        if (question.length < 6) continue
        out.push({ type: String(task.type ?? 'A').slice(0, 1), question, hint: String(task.hint ?? '') })
        if (out.length >= PRACTICE_MAX_TASKS) return out
      }
      if (out.length > 0) return out
    }
    for (const line of String(raw ?? '').split('\n')) {
      const clean = line.replace(/^\s*[-*·]?\s*(\d+[.、)]\s*)?/, '').trim()
      if (clean.length < 6) continue
      const parts = clean.split('|').map(function (one) { return one.trim() })
      if (parts.length < 2) continue
      const type = /^[ABC]$/.test(parts[0]) ? parts[0] : null
      if (type === null) continue
      const question = parts[1]
      if (question.length < 6) continue
      out.push({ type, question, hint: parts[2] ?? '' })
      if (out.length >= PRACTICE_MAX_TASKS) break
    }
    return out
  }

  /**
   * 从代码块里认出文件名。模型三种写法都见过：
   * `​```js` + 第一行注释写文件名 / `​```safePatch.js` / 正文里写「文件名：x.js」。
   * 认不出来就给个序号名——写进沙盒而已，别为了名字把作业丢了。
   */
  function fileNameOf(info, body, index) {
    const clean = function (name) {
      const base = String(name ?? '').split('/').pop().split('\\').pop().trim().slice(0, 60)
      return /^[\w.\-]{1,60}$/.test(base) ? base : ''
    }
    const named = /^\s*(?:\/\/|#|--|<!--)?\s*(?:file|filename|文件名)[:：]\s*([\w.\-/]+)/im.exec(body)
    if (named !== null) {
      const name = clean(named[1])
      if (name.length > 0) return name
    }
    if (/^[\w.\-]+\.[A-Za-z0-9]{1,6}$/.test(info)) {
      const name = clean(info)
      if (name.length > 0) return name
    }
    const firstLine = body.split('\n')[0]
    const comment = /^\s*(?:\/\/|#|--)\s*([\w.\-/]+\.[A-Za-z0-9]{1,6})\s*$/.exec(firstLine)
    if (comment !== null) {
      const name = clean(comment[1])
      if (name.length > 0) return name
    }
    const ext = /^[a-z]{1,10}$/i.test(info) ? info.toLowerCase() : 'txt'
    return 'block-' + index + '.' + ext
  }

  /** 经验：一行一条；去掉编号、引号、句型前缀。 */
  function parseLessons(raw) {
    const out = []
    const json = parseJsonReply(raw)
    const source = json !== null && Array.isArray(json.lessons) ? json.lessons : String(raw ?? '').split('\n')
    for (const item of source) {
      if (typeof item !== 'string') continue
      const line = item.replace(/^\s*[-*·]?\s*(\d+[.、)]\s*)?/, '').replace(/^["「']|["」']$/g, '').trim()
      if (line.length < 6) continue
      out.push(clip(line, 80))
      if (out.length >= 2) break
    }
    return out
  }

  // ── 掷色子 ─────────────────────────────────────────────────────────────────
  function isoDay(ts) {
    const p = beijingParts(ts)
    return p.year + '-' + p.month + '-' + p.day
  }

  async function tick(reason) {
    if (busy) return
    const now = Date.now()
    const cfg = config()
    // 整理梦：和 ACC 同一套账
    if (cfg.tidy.enabled) {
      const st = state()
      const week = weekWindow(now)
      let tidy = st.tidy
      if (tidy.week !== week.label) {
        const missed = tidy.week !== '' && tidy.count === 0
        tidy = { week: week.label, count: 0, carry: missed ? 1 : 0, rolledDay: '', fireAt: 0, lastAt: tidy.lastAt, failures: 0, lastError: tidy.lastError }
        st.tidy = tidy
        saveState(st)
      }
      const need = cfg.tidy.perWeek + (tidy.carry > 0 ? 1 : 0) - tidy.count
      const lastAt = tidy.lastAt.length > 0 ? Date.parse(tidy.lastAt) : Number.NaN
      const gap = Number.isNaN(lastAt) ? Infinity : now - lastAt
      if (need > 0 && gap >= TIDY_MIN_GAP) {
        if (tidy.rolledDay !== isoDay(now)) {
          const left = Math.max(1, Math.ceil((week.end - now) / DAY))
          tidy.rolledDay = isoDay(now)
          tidy.fireAt = Math.random() < Math.min(1, need / left) ? now + 15000 + Math.floor(Math.random() * 2 * HOUR) : 0
          saveState(st)
        }
        const left = Math.ceil((week.end - now) / DAY)
        if (tidy.fireAt === 0 && (week.end - now < need * DAY * 0.75 || (tidy.count === 0 && left <= Math.ceil(cfg.tidy.perWeek * 2)))) {
          tidy.fireAt = now + 10000
          saveState(st)
        }
        if (tidy.fireAt > 0 && now >= tidy.fireAt) await runTidy(false)
      }
    }
    // 练习梦：到日子 + 窗口 + 机器闲
    const after = state()
    if (after.practice.nextAt === 0) {
      after.practice.nextAt = now + cfg.practice.everyDays * DAY
      saveState(after)
      return
    }
    if (practiceGate(now).ok) await runPractice(false)
  }

  // ── 接到 harness 上 ────────────────────────────────────────────────────────
  // 任何一次上下文装配都说明「有人正在用」；练习梦的门槛之一就是这个时间戳。
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dsh-memory-dream',
    order: 145,
    text: () => {
      lastActive = Date.now()
      const cfg = config()
      if (cfg.inject === 0) return ''
      const rows = readExperiences(cfg.inject)
      if (rows.length === 0) return ''
      return '练手记下的（来自模拟环境，不是事实，用之前先自己核）：\n' + rows.map(function (row) { return '· ' + clip(row.text, 60) }).join('\n')
    }
  }), 'dsh-memory-dream.context')

  ctx.effect(() => {
    const first = setTimeout(function () { tick('boot').catch(function () {}) }, 45000)
    const timer = setInterval(function () { tick('tick').catch(function () {}) }, TICK_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, 'dsh-memory-dream.tick')

  // 手动入口：没有它就只能等午夜那一拍，调试和用户自己触发都没路。
  if (ctx.webServer !== undefined && ctx.webServer !== null) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-dream',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://local')
        const path = url.pathname
        function send(status, body) {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body, null, 2))
        }
        if (path.endsWith('/status')) {
          const cfg = config()
          const st = state()
          const gate = practiceGate(Date.now())
          return send(200, { ok: true, config: cfg, state: st, gate, load: systemLoad(), inWorkBlock: inWorkBlock(Date.now(), dir), restDay: isRestDay(Date.now(), dir) })
        }
        if (path.endsWith('/probe')) {
          // 只用来定位模型为什么空返回：给出分块类型、结束原因、正文长度。
          const q = url.searchParams.get('q') ?? ''
          const maxTokens = Number(url.searchParams.get('maxTokens') ?? 3000)
          const shown = { ok: true, kinds: {}, finish: '', chars: 0, text: '', reasoningChars: 0, usage: 0, ms: 0 }
          const started = Date.now()
          try {
            const said = []
            const thought = []
            const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
            const provider = url.searchParams.get('provider') ?? (providers[0]?.id ?? 'deepseek-official')
            const model = url.searchParams.get('model') ?? 'deepseek-flash'
            const effort = url.searchParams.get('effort')
            const request = { provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: q }] }], maxTokens }
            if (effort !== null && effort.length > 0) request.reasoningEffort = effort
            if (url.searchParams.get('info') === '1' && typeof llm.listModels === 'function') {
              shown.models = await llm.listModels(provider)
            }
            for await (const chunk of llm.stream(request)) {
              if (chunk === null || typeof chunk !== 'object') continue
              shown.kinds[String(chunk.type)] = (shown.kinds[String(chunk.type)] ?? 0) + 1
              if (chunk.type === 'text-delta') said.push(String(chunk.text ?? ''))
              if (chunk.type === 'reasoning-delta') thought.push(String(chunk.text ?? ''))
              if (chunk.type === 'finish') shown.finish = typeof chunk.reason === 'string' ? chunk.reason : JSON.stringify(chunk.reason ?? '')
              if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
                shown.usage += Number(chunk.usage.totalTokens ?? 0) || 0
              }
            }
            shown.text = said.join('')
            shown.chars = shown.text.length
            shown.reasoningChars = thought.join('').length
            shown.provider = provider
          } catch (error) {
            shown.ok = false
            shown.error = String(error?.message ?? error)
          }
          shown.ms = Date.now() - started
          return send(200, shown)
        }
        if (req.method === 'POST' && path.endsWith('/run')) {
          const what = url.searchParams.get('what') ?? 'tidy'
          const record = what === 'practice' ? await runPractice(true) : await runTidy(true)
          return send(record.ok === true ? 200 : 500, record)
        }
        if (req.method === 'POST' && path.endsWith('/config')) {
          const next = readJson(configPath, {})
          for (const key of ['inject', 'loadCeiling']) {
            const raw = url.searchParams.get(key)
            if (raw !== null) next[key] = Number(raw)
          }
          for (const key of ['tidy', 'practice']) {
            const raw = url.searchParams.get(key)
            if (raw === '0' || raw === '1') {
              next[key] = { ...(next[key] ?? {}), enabled: raw === '1' }
            }
          }
          const perWeek = url.searchParams.get('perWeek')
          if (perWeek !== null && Number.isFinite(Number(perWeek))) {
            next.tidy = { ...(next.tidy ?? {}), perWeek: Math.max(1, Math.min(7, Math.floor(Number(perWeek)))) }
          }
          const everyDays = url.searchParams.get('everyDays')
          if (everyDays !== null && Number.isFinite(Number(everyDays))) {
            next.practice = { ...(next.practice ?? {}), everyDays: Math.max(1, Math.floor(Number(everyDays))) }
          }
          const budget = url.searchParams.get('budget')
          if (budget !== null && Number.isFinite(Number(budget))) {
            next.practice = { ...(next.practice ?? {}), budget: Math.max(100, Math.floor(Number(budget))) }
          }
          writeJson(configPath, next)
          return send(200, { ok: true, config: config() })
        }
        return send(200, { ok: true, routes: ['/dsh-dream/status', 'POST /dsh-dream/run?what=tidy|practice', 'POST /dsh-dream/config'] })
      }
    }), 'dsh-memory-dream.route')
  }

  ctx.effect(() => ctx.tools.register({
    name: 'memory_dream',
    description: '做梦：整理梦重建记忆索引（timeline/index/terms）并合并重复；练习梦让模型按记忆给自己出题、回答，在沙盒里积累经验（每 10 天一次，只在非上班时段、机器空闲时自动做）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'tidy', 'practice', 'read'], description: 'status=看状态；tidy=现在整理一次；practice=现在练一次（会绕过时间窗，但仍需机器空闲）；read=读最近一次练习。' },
        query: { type: 'string', description: 'status 时可选：顺便用索引查几个词，看命中哪些 id。' }
      }
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) {
      const input = args ?? {}
      if (input.action === 'tidy') {
        const record = await runTidy(true)
        return (record.ok ? '整理完了：' : '整理没做成：') + (record.steps ?? []).join(' · ') + ((record.errors ?? []).length > 0 ? '\n问题：' + record.errors.join('；') : '')
      }
      if (input.action === 'practice') {
        const record = await runPractice(true)
        if (record.ok !== true) return '这次没练成：' + (record.errors ?? []).join('；')
        return '练完了（' + Math.round(record.ms / 1000) + ' 秒，' + record.spent + ' tokens）：\n'
          + record.tasks.map(function (task, index) { return (index + 1) + '. [' + task.type + '] ' + task.question + '\n   ' + task.answer.slice(0, 200) }).join('\n')
          + ((record.lessons ?? []).length > 0 ? '\n经验：' + record.lessons.join(' / ') : '')
      }
      if (input.action === 'read') {
        try { return readFileSync(join(root, 'last-practice.json'), 'utf8').slice(0, 4000) } catch { return '还没练过。' }
      }
      const now = Date.now()
      const cfg = config()
      const st = state()
      const gate = practiceGate(now)
      const week = weekWindow(now)
      const lines = [
        '整理梦：本周 ' + (st.tidy.week === week.label ? st.tidy.count : 0) + ' / ' + cfg.tidy.perWeek
          + '；上次 ' + (st.tidy.lastAt.length > 0 ? st.tidy.lastAt.slice(0, 16).replace('T', ' ') : '还没做过'),
        '练习梦：' + (st.practice.lastAt.length > 0 ? ('上次 ' + st.practice.lastAt.slice(0, 16).replace('T', ' ')) : '还没做过')
          + '；下次 ' + (st.practice.nextAt === 0 ? '（待定）' : new Date(st.practice.nextAt).toISOString().slice(0, 16).replace('T', ' ')),
        '现在能练吗：' + (gate.ok ? '可以' : gate.why),
        '负载：' + systemLoad().toFixed(2) + '（上限 ' + cfg.loadCeiling + '）'
      ]
      if (input.query !== undefined && String(input.query).length > 0) {
        const hits = searchIndex(String(input.query), 10)
        lines.push('索引查询：' + (hits === null ? '还没有索引，先跑一次 tidy' : (hits.length === 0 ? '没命中' : hits.map(function (hit) { return '#' + hit.id + '(' + hit.score + ')' }).join(' '))))
      }
      return lines.join('\n')
    }
  }), 'dsh-memory-dream.tool')

  return { tick, runTidy, runPractice, searchIndex, rebuildIndex, practiceGate, config, state, readExperiences, isRestDay: function (ts) { return isRestDay(ts, dir) }, inWorkBlock: function (ts) { return inWorkBlock(ts, dir) } }
}
