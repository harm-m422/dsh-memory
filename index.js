/**
 * 元认知插件 · 任务边界层
 *
 * 只暴露两个模型可调用的工具：
 *   task_start  声明一个任务（目标 + 预期结果）
 *   task_end    声明该任务的结果，并触发事后反思材料注入
 *
 * 设计约束：
 *   1. 任务事件写到独立文件 tasks.jsonl（反思结束可删，符合规格）
 *   2. 不复制工具事件；用 [start_seq, end_seq] 圈选既有 tool-events / error-events
 *   3. 反思材料通过 exec.deferContext() 进入下一步，不做任何阻塞式调用
 *   4. 若新任务开始时旧任务未结束，旧任务标记 closed_by=superseded + abandoned
 */
import { join } from "node:path";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildTaskRecord, newTaskId, TASK_STATUS, validateEnd, validateStart } from "./lib/task-model.js";
import { renderReflectionBrief, sliceDecisionTrail } from "./lib/task-context.js";
import { buildReflectionRecord, validateReflect } from "./lib/reflection-model.js";
import { createLessonStore, renderLessonsSection, parseLessons, parseLessonEntries, parseCommitState, pendingReflections } from "./lib/lessons.js";
import { renderInstantNotice, shouldCommit } from "./lib/instant-notice.js";
import { classifyToolOutcome } from "./lib/classify.js";
import { createDurableWriter } from "./lib/writer.js";

export const name = "lessons";

/**
 * 硬依赖 tools：本插件的核心价值就是三个工具。
 *
 * 之前写成空数组，导致插件可能先于 `tools` 服务激活——那样
 * `ctx.get("tools")` 返回 undefined，工具注册被静默跳过，
 * 而 systemPrompt 段（在工具注册之前执行）却已经注册成功，
 * 于是出现「系统提示里有 Task boundaries，但模型手上没有 task_start」。
 *
 * 声明 inject 后，Cordis 会等 tools 就绪才调用 apply，与激活顺序无关。
 */
export const inject = ["tools"];

/**
 * 任务边界提示段的静态正文。
 *
 * 位置很关键：放在工具文档之前（order 700），否则会被 8k 字符的
 * 工具说明淹没——实测放在末尾时合规率只有 1/2。
 *
 * 这里只给判定规则；完整定义在 task_start 的工具描述里，不重复。
 */
const TASK_BOUNDARY_TEXT = [
  "## Task boundaries",
  "",
  "A task is a unit of work with a clear goal or expected result that takes one or more steps.",
  "Work the user asks for counts; so do investigation, analysis, verification, edits, and",
  "generation. Success is not required, and tool use is not required. When it is unclear",
  "whether a unit of work is a task, treat it as one rather than excluding it.",
  "",
  "You MUST call task_start as the FIRST action of a task — before reading files, running",
  "commands, searching, or editing anything. Never do the work first and declare the task",
  "afterwards; a task declared after the fact has no decision record.",
  "Call task_end once that result exists, whether or not it succeeded.",
].join("\n");

/**
 * 漏开任务时的提醒正文。
 *
 * 措辞必须与上面的判定保持一致——否则模型会拿到两套「什么算任务」的标准。
 *
 * 这里**只向前看**：明确不要求事后补开。原因是补开得到的决策窗口是空的，
 * 反思只能基于零证据编造；而 TASK_BOUNDARY_TEXT 本身也写着
 * 「Never do the work first and declare the task afterwards」。
 * 两份文本若一要求补开、一禁止补开，模型会收到互相冲突的指令。
 */
function missedTaskText(calls, edits) {
  const work = [`${calls} 次工具调用`];
  if (edits > 0) work.push(`${edits} 次文件改动`);
  return [
    "<lessons_task_missing>",
    `这一回合做了实际工作（${work.join("、")}），但没有声明任何任务。`,
    "",
    "按任务的定义：一个具有明确目标或预期结果、需要一个或多个工作步骤才能完成的工作单元。",
    "用户要求完成的工作算任务；不确定是否属于任务时，优先把它当作任务。",
    "",
    "从下一个任务开始：把 task_start 作为第一项动作，先于读文件、运行命令、搜索或编辑。",
    "本次不需要事后补开——补开得到的决策窗口是空的，反思只能基于零证据编造。",
    "</lessons_task_missing>",
  ].join("\n");
}

const DEFAULTS = {
  taskDir: join(process.cwd(), "dsh-lessons-data"),
  fsyncEvery: 32,
  /** 反思材料注入开关，便于对照测试 */
  injectReflection: true,
  /**
   * 是否把「决策环境快照」渲染进反思材料（默认开启）。
   *
   * 记录本身（task_open.environment）**始终写入**，与本开关无关 —— 它供事后审计、
   * 追查经验影响、保证历史不可变。
   *
   * 渲染只影响反思材料里的 DECISION ENVIRONMENT 段：
   *   · 开启：反思时不用回翻几十万 token 去 system prompt 找当时生效的约束，
   *           近因效应下更容易做出「我有没有遵循」的判断；
   *   · 关闭：省下约 800 token/次反思（实测 11 条经验约 1986 字符），
   *           代价是模型需要自己往上翻。
   */
  environmentInBrief: true,
  /**
   * 复盘保持安静（默认开启）：要求模型把复盘放在思维链里，不要写成对外回复。
   *
   * 实测（本会话 78 次 task_end→task_reflect 配对）：
   *   · 50% 的复盘先写一段对外文本，平均 784 字符，最长 6660；
   *   · 这段文本不进入反思记录 —— buildReflectionRecord 只读 task_reflect 的参数；
   *   · 但若它落在后续某个任务的 [start_seq, end_seq] 窗口内，会被 sliceDecisionTrail
   *     当成那个任务的 ASSISTANT 条目收进反思材料。
   *
   * 所以对外复述既不是写入通道，也不是零成本：它只是把同一份分析付两次钱，
   * 并给后面的任务轨迹掺入不属于它的内容。关闭后恢复旧行为。
   */
  silentReflection: true,
  /**
   * 任务状态从 `tasks.jsonl` 推导（默认开启）。
   *
   * 进行中任务、可反思任务、「本会话是否开过任务」、提醒次数原本都是内存态，
   * 插件重载或进程重启后全部丢失，导致任务断裂与反复误报。这些事实其实都
   * 写在 tasks.jsonl 里，启动时按文件重建即可。
   *
   * 关闭后退回纯内存态（重载即丢）。
   */
  stateFromFile: true,
  /** 事件落盘（工具调用/失败），只记录不注入 */
  recordEvents: true,
  /** 任务边界提示段（告诉模型何时调用 task_start / task_end） */
  taskBoundaryHints: true,
  taskBoundarySectionName: "lessons:task-boundaries",
  // 700 = 在 PLAN_POLICY(500)/TEAM_POLICY(600) 之后、所有工具段(1000+) 之前。
  // 放在末尾时实测被工具文档淹没，合规率只有 1/2。
  taskBoundaryOrder: 700,
  /**
   * 漏开任务的提醒：一个回合做了实质工作却从未声明任务时，在回合收尾注入一次提示。
   * mode: "inject" 只进下一次输入（不唤醒，零额外成本）；
   *       "wake"   立刻唤醒 Agent 跑一个补录回合（会产生额外回合）。
   */
  missedTaskNudge: true,
  missedTaskNudgeMode: "inject",
  /**
   * 触发提醒所需的最少工具调用数。
   *
   * 3 太低：正常的分析/验证任务动辄十几次调用，会被普遍判为「漏开」并反复打扰。
   * 提醒只用于捕捉明显偏离（一整回合都在干活却忘了声明），因此取较高阈值。
   */
  missedTaskMinCalls: 8,
  missedTaskMaxPerSession: 2,
  /** 步骤 3：把积累的经验注入 system prompt */
  lessons: {
    enabled: true,
    sectionName: "lessons:accumulated",
    /** 排在所有既有段落之后：前缀尽量复用，只有尾部随记忆变化 */
    order: 10500,
    /** 0 = 不截断（按当前阶段要求：每条记忆都进上下文） */
    maxLessons: 0,
    /** 每次装配产出的内容变化时记一条诊断 */
    diagnostics: true,
    /**
     * 三域开关。默认全开；对照实验可按域关闭。
     *   global     跨任务工作方法（所有会话）
     *   session    会话背景（仅本会话）
     *   reflection 任务反思（仅本会话）
     */
    scopes: { global: true, session: true, reflection: true },
    /** 手工/晋升写入的 global 与 session 条目；默认 <taskDir>/lessons/lessons.jsonl */
    lessonFile: undefined,
    /**
     * 攒批总开关（默认开启）。
     *
     * 开启后：新反思不立即改 system prompt，而是先累积成 pending，
     * 达到阈值才推进一次水位 —— 这样每条反思都不会触发全量重算。
     */
    batching: true,
    /**
     * 反思即时注入：task_reflect 后立刻发一条 plugin 通知。
     *
     * 依据 2026-11-07 实测（cache-probe/controlled.mjs）：
     *   plugin 类注入 20/20 样本命中率 >= 99.6%（均值 99.9%）
     *   system/message 变更 8/8 样本命中率 <= 0.7%（多数 cached=0）
     * 因此「即时注入 + system prompt 攒批」用极小的缓存代价换取近因效果。
     *
     * 注意：仅在 batching 开启时有效。攒批关闭时 section 已实时反映全部条目，
     * 再发即时通知会重复。
     */
    instantNotice: true,
    /** 攒批阈值：待提交条数达到该值即触发一次 system prompt 重算。0 = 只看 token 阈值 */
    commitEvery: 8,
    /** 攒批 token 阈值（按字符数/3 粗估）；0 = 不按 token 判断 */
    commitEveryTokens: 0,
  },
};

function readConfig(raw) {
  const cfg = { ...DEFAULTS, lessons: { ...DEFAULTS.lessons, scopes: { ...DEFAULTS.lessons.scopes } } };
  if (raw && typeof raw === "object") {
    if (typeof raw.taskDir === "string" && raw.taskDir) cfg.taskDir = raw.taskDir;
    if (Number.isSafeInteger(raw.fsyncEvery) && raw.fsyncEvery > 0) cfg.fsyncEvery = raw.fsyncEvery;
    if (typeof raw.injectReflection === "boolean") cfg.injectReflection = raw.injectReflection;
    if (typeof raw.environmentInBrief === "boolean") cfg.environmentInBrief = raw.environmentInBrief;
    if (typeof raw.silentReflection === "boolean") cfg.silentReflection = raw.silentReflection;
    if (typeof raw.stateFromFile === "boolean") cfg.stateFromFile = raw.stateFromFile;
    if (typeof raw.recordEvents === "boolean") cfg.recordEvents = raw.recordEvents;
    if (typeof raw.taskBoundaryHints === "boolean") cfg.taskBoundaryHints = raw.taskBoundaryHints;
    if (typeof raw.taskBoundarySectionName === "string" && raw.taskBoundarySectionName) {
      cfg.taskBoundarySectionName = raw.taskBoundarySectionName;
    }
    if (Number.isFinite(raw.taskBoundaryOrder)) cfg.taskBoundaryOrder = raw.taskBoundaryOrder;
    if (typeof raw.missedTaskNudge === "boolean") cfg.missedTaskNudge = raw.missedTaskNudge;
    if (raw.missedTaskNudgeMode === "inject" || raw.missedTaskNudgeMode === "wake") {
      cfg.missedTaskNudgeMode = raw.missedTaskNudgeMode;
    }
    if (Number.isSafeInteger(raw.missedTaskMinCalls) && raw.missedTaskMinCalls > 0) {
      cfg.missedTaskMinCalls = raw.missedTaskMinCalls;
    }
    if (Number.isSafeInteger(raw.missedTaskMaxPerSession) && raw.missedTaskMaxPerSession >= 0) {
      cfg.missedTaskMaxPerSession = raw.missedTaskMaxPerSession;
    }
    if (raw.lessons && typeof raw.lessons === "object") {
      const l = raw.lessons;
      if (typeof l.enabled === "boolean") cfg.lessons.enabled = l.enabled;
      if (typeof l.sectionName === "string" && l.sectionName) cfg.lessons.sectionName = l.sectionName;
      if (Number.isFinite(l.order)) cfg.lessons.order = l.order;
      if (Number.isSafeInteger(l.maxLessons) && l.maxLessons >= 0) cfg.lessons.maxLessons = l.maxLessons;
      if (typeof l.diagnostics === "boolean") cfg.lessons.diagnostics = l.diagnostics;
      if (typeof l.lessonFile === "string" && l.lessonFile) cfg.lessons.lessonFile = l.lessonFile;
      if (typeof l.batching === "boolean") cfg.lessons.batching = l.batching;
      if (typeof l.instantNotice === "boolean") cfg.lessons.instantNotice = l.instantNotice;
      if (Number.isSafeInteger(l.commitEvery) && l.commitEvery >= 0) cfg.lessons.commitEvery = l.commitEvery;
      if (Number.isSafeInteger(l.commitEveryTokens) && l.commitEveryTokens >= 0) cfg.lessons.commitEveryTokens = l.commitEveryTokens;
      if (l.scopes && typeof l.scopes === "object") {
        for (const k of ["global", "session", "reflection"]) {
          if (typeof l.scopes[k] === "boolean") cfg.lessons.scopes[k] = l.scopes[k];
        }
      }
    }
  }
  return cfg;
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function apply(ctx, rawConfig) {
  const cfg = readConfig(rawConfig);
  const logger = safe(() => ctx.logger, undefined);
  const warn = (m) => safe(() => logger?.warn?.(m));
  const info = (m) => safe(() => logger?.info?.(m));

  /**
   * 攒批是否真正生效。
   *
   * 开关 ``batching`` 之外还要求至少一个阈值有效：两者都为 0 时没有提交点，
   * 攒批会永远不触发（pending 只增不减），不如直接视为关闭。
   */
  const batchingOn =
    cfg.lessons.batching !== false &&
    (cfg.lessons.commitEvery > 0 || cfg.lessons.commitEveryTokens > 0);
  /** 即时通知只在攒批开启时才有意义，否则与实时 section 重复。 */
  const instantNoticeOn = batchingOn && cfg.lessons.instantNotice !== false;

  const writer = createDurableWriter(join(cfg.taskDir, "tasks.jsonl"), {
    fsyncEvery: cfg.fsyncEvery,
    onError: (phase, e) => warn(`[lessons] tasks ${phase}: ${String(e)}`),
  });

  const taskFile = join(cfg.taskDir, "tasks.jsonl");
  const lessonFile = cfg.lessons.lessonFile ?? join(cfg.taskDir, "lessons", "lessons.jsonl");

  // ── 步骤 3：把积累的反思注入 system prompt ──────────────────────────────
  const lessonStore = createLessonStore({ taskFile, lessonFile });

  // ── 事件储存（原事件储存模块，已并入本插件）──────────────────────────
  // 只落盘，不做任何注入：工具计数注入会污染实验条件，已废弃。
  let toolWriter;
  let errorWriter;
  if (cfg.recordEvents) {
    toolWriter = createDurableWriter(join(cfg.taskDir, "tool-events.jsonl"), {
      fsyncEvery: cfg.fsyncEvery,
      onError: (phase, e) => warn(`[lessons] tool-events ${phase}: ${String(e)}`),
    });
    errorWriter = createDurableWriter(join(cfg.taskDir, "error-events.jsonl"), {
      fsyncEvery: cfg.fsyncEvery,
      onError: (phase, e) => warn(`[lessons] error-events ${phase}: ${String(e)}`),
    });

    ctx.on("tools/result", (exec, result) => {
      try {
        const outcome = classifyToolOutcome(exec, result);
        const agent = safe(() => exec?.agent, undefined);
        const record = {
          ev: "tool",
          ts: Date.now(),
          sessionId: sessionIdOf(agent),
          agentId: safe(() => agent?.id, undefined),
          cwd: safe(() => agent?.session?.header?.cwd, undefined),
          callId: safe(() => exec?.callId, undefined),
          tool: safe(() => exec?.name, undefined),
          failed: outcome.failed === true,
          signals: Array.isArray(outcome.signals) ? outcome.signals : [],
        };
        toolWriter.append(`${JSON.stringify(record)}\n`);
        if (record.failed) {
          errorWriter.append(`${JSON.stringify({ ...record, ev: "error", detail: outcome.detail ?? null })}\n`);
        }
      } catch (e) {
        warn(`[lessons] tools/result handler swallowed: ${String(e)}`);
      }
    });

    ctx.effect(
      () => () => {
        safe(() => toolWriter.close());
        safe(() => errorWriter.close());
      },
      "lessons: event writers",
    );
  }

  let lastRenderedHash = "";
  let hintRendered = false;
  let renderCount = 0;

  function diagnostics(entry) {
    if (!cfg.lessons.diagnostics) return;
    try {
      appendFileSync(join(cfg.taskDir, "lessons-render.jsonl"), `${JSON.stringify(entry)}\n`);
    } catch {
      /* 诊断失败不影响注入 */
    }
  }

  /**
   * 每次装配都会被调用；读盘走 mtime 缓存，只有内容变化才写诊断。
   * context 由 Agent 循环传入（{ agent, scope }），用于按会话/工作区分域。
   */
  /**
   * 从装配上下文解析当前会话。
   *
   * 当前 DSH 的 AssembleContext 只有 { scope, signal }，没有 agent。
   * scope 就是 Agent 对象本身（ScopeKey），因此：
   *   1. 优先读 scope.id（Agent.id 即 SessionId）
   *   2. 回退到 agents.get(scope) —— 覆盖 scope 为其它 carrier 的情况
   * 两者都拿不到时返回 null，此时只注入 global 层。
   */
  function resolveSessionId(context) {
    const scope = context?.scope;
    if (scope === undefined || scope === null) return null;
    const direct = safe(() => scope.id, null);
    if (typeof direct === "string" && direct) return direct;
    const agents = safe(() => ctx.get("agents"), undefined);
    if (agents !== undefined) {
      const found = safe(() => agents.list?.()?.find((a) => a === scope || a?.id === scope), undefined);
      const id = safe(() => found?.id, null);
      if (typeof id === "string" && id) return id;
    }
    const viaGet = safe(() => agents?.get?.(scope), undefined);
    const id2 = safe(() => viaGet?.id, null);
    return typeof id2 === "string" && id2 ? id2 : null;
  }

  function renderSectionText(context) {
    try {
      // 分域求值：global 全局可见；session/reflection 只对所属会话可见
      const sessionId = resolveSessionId(context);
      // 攒批水位：水位之后的反思不进 section（它们只走即时通知），
      // 只有攒满提交后 section 才变化一次 —— 这是缓存友好的关键。
      let committedAt = Number.POSITIVE_INFINITY;
      if (batchingOn) {
        committedAt = parseCommitState(lessonStore.readTaskText());
      }
      const { lessons } = lessonStore.read(sessionId, cfg.lessons.scopes, committedAt);
      const text = renderLessonsSection(lessons, { maxLessons: cfg.lessons.maxLessons });
      renderCount += 1;
      const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
      if (hash !== lastRenderedHash) {
        lastRenderedHash = hash;
        const byScope = { global: 0, session: 0, reflection: 0 };
        for (const l of lessons) byScope[l.scope] = (byScope[l.scope] ?? 0) + 1;
        diagnostics({
          ts: Date.now(),
          lessons: lessons.length,
          byScope,
          chars: text.length,
          hash,
          ids: lessons.map((l) => l.id).slice(0, 50),
          renders: renderCount,
          // 诊断：区分「带 agent 的装配」与「不带 agent 的装配」
          ctxKeys: Object.keys(context ?? {}).sort().join(","),
          hasScope: context?.scope !== undefined,
          session: sessionId,
          cwd: null, // 当前 AssembleContext 不提供 cwd
        });
      }
      return text;
    } catch (e) {
      warn(`[lessons] lesson section render failed: ${String(e)}`);
      return "";
    }
  }

  const systemPrompt = safe(() => ctx.get("systemPrompt"), undefined);
  if (systemPrompt === undefined) {
    if (cfg.lessons.enabled || cfg.taskBoundaryHints) {
      warn("[lessons] systemPrompt service unavailable; prompt sections will not be injected");
    }
  } else {
    // 任务边界提示：静态文本，告诉模型「什么时候」用这两个工具。
    // 「怎么用」在工具定义里，不在这里重复。
    if (cfg.taskBoundaryHints) {
      const disposeHints = systemPrompt.section({
        name: cfg.taskBoundarySectionName,
        order: cfg.taskBoundaryOrder,
        interpolate: false,
        // 内容是常量；用函数形式只为记录一次「确实被装配过」的证据
        text: () => {
          if (!hintRendered) {
            hintRendered = true;
            diagnostics({
              ts: Date.now(),
              section: cfg.taskBoundarySectionName,
              kind: "task-boundaries",
              chars: TASK_BOUNDARY_TEXT.length,
            });
          }
          return TASK_BOUNDARY_TEXT;
        },
      });
      ctx.effect(() => () => safe(() => disposeHints?.()));
      info(`[lessons] task-boundary section "${cfg.taskBoundarySectionName}" registered at order ${cfg.taskBoundaryOrder}`);
    }

    if (cfg.lessons.enabled) {
      const dispose = systemPrompt.section({
        name: cfg.lessons.sectionName,
        // 放在所有既有段落之后：前缀尽量复用，只让尾部随记忆变化
        order: cfg.lessons.order,
        interpolate: false,
        text: renderSectionText,
      });
      ctx.effect(() => () => safe(() => dispose?.()));
      info(`[lessons] lessons section "${cfg.lessons.sectionName}" registered at order ${cfg.lessons.order}`);
    }
  }

  // ── 漏开任务提醒 ────────────────────────────────────────────────────────
  /** 曾经开过任务的会话：开过一次就不再提醒。 */
  const everOpened = new Set();
  /** 已经扫描过历史、确认没有 task_start 的会话（避免每回合重扫）。 */
  const scannedNoTask = new Set();
  /** 每个会话已提醒的次数。 */
  const nudgeCount = new Map();

  /**
   * 该会话是否曾经开过任务。
   *
   * 不能只靠内存集合：插件重载或进程重启会清空它，于是「两天前开过任务」
   * 的会话会被误判成从未开过、收到误报。所以首次判断时回扫一次会话日志，
   * 之后靠集合（task_start 也会即时写入集合）与「已扫描」标记短路。
   *
   * 注意：**只有确实读到历史时才缓存否定结论**。`readEvents` 在
   * sessionQuery 未就绪或瞬时失败时返回空数组，此时若直接写入
   * scannedNoTask，该会话会被永久误判为「从未开过任务」——此后每回合
   * 都会误报，直到下次插件重载。实测曾出现：日志里已有 28 次 task_start，
   * 仍持续收到「没有声明任何任务」。
   */
  async function sessionEverOpenedTask(agent, sessionId) {
    if (everOpened.has(sessionId)) return true;
    // 文件推导开启时，everOpened 已由 tasks.jsonl 重建，是权威来源：
    // 没有记录就是确实没开过任务，无需再扫会话日志（既慢又易受读取失败影响）。
    if (cfg.stateFromFile) return false;
    if (scannedNoTask.has(sessionId)) return false;
    const events = await readEvents(sessionIdOf(agent) ?? sessionId);
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e?.type === "tool/call" && e.data?.name === "task_start") {
          everOpened.add(sessionId);
          return true;
        }
      }
    }
    // 诊断：判定为「没开过任务」时记录读到了什么，用于区分
    // 「真的没开过」与「读不到 tool/call 事件」。仅在即将缓存否定结论时记录一次。
    if (Array.isArray(events) && events.length > 0 && !scannedNoTask.has(sessionId)) {
      const types = {};
      const names = {};
      let taskStarts = 0;
      let sampleMissingName = 0;
      for (const e of events) {
        types[e?.type ?? "?"] = (types[e?.type ?? "?"] ?? 0) + 1;
        if (e?.type === "tool/call") {
          const n = e?.data?.name;
          if (typeof n !== "string" || !n) sampleMissingName += 1;
          else {
            names[n] = (names[n] ?? 0) + 1;
            if (n === "task_start") taskStarts += 1;
          }
        }
      }
      const topNames = Object.entries(names)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
      diagnostics({
        ts: Date.now(),
        kind: "missed-task-check",
        session: sessionId,
        events: events.length,
        hasToolCall: Object.prototype.hasOwnProperty.call(types, "tool/call"),
        taskStarts,
        missingName: sampleMissingName,
        topNames,
        types,
      });
      scannedNoTask.add(sessionId);
    }
    return false;
  }

  /**
   * 回合收尾时检查：本回合做了实质工作，但整个会话从未声明任务。
   *
   * 事件是 serial（无框架兜底），所以整体 try/catch，且绝不做耗时操作。
   */
  ctx.on("agent/turn-stopping", async (payload) => {
    try {
      if (!cfg.missedTaskNudge) return;
      const agent = payload?.agent;
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return;
      if (await sessionEverOpenedTask(agent, sessionId)) return;

      const used = nudgeCount.get(sessionId) ?? 0;
      if (used >= cfg.missedTaskMaxPerSession) return;

      const events = await readEvents(sessionIdOf(agent) ?? sessionId);
      if (!Array.isArray(events) || events.length === 0) return;

      // 只看当前回合：从最后一个 turn/start 起算
      let turnStart = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === "turn/start") {
          turnStart = i;
          break;
        }
      }
      if (turnStart < 0) return;

      let calls = 0;
      let edits = 0;
      for (let i = turnStart; i < events.length; i++) {
        const e = events[i];
        if (e?.type !== "tool/call") continue;
        const name = e.data?.name;
        // task_start 的在场与否已由 sessionEverOpenedTask 统一判断
        if (name === "task_start") continue;
        calls += 1;
        if (name === "edit" || name === "write") edits += 1;
      }
      if (calls < cfg.missedTaskMinCalls && edits === 0) return;

      nudgeCount.set(sessionId, used + 1);
      // 落盘：重载后仍记得已提醒几次，否则 missedTaskMaxPerSession 形同虚设
      if (cfg.stateFromFile) {
        safe(() =>
          writeRecord({
            record_type: "nudge",
            session_id: sessionId,
            turn: payload?.turn ?? null,
            calls,
            edits,
            recorded_at: Date.now(),
          })
        );
      }
      const message = makeNoticeMessage(missedTaskText(calls, edits), `missed task in turn ${payload?.turn ?? "?"}`);
      if (cfg.missedTaskNudgeMode === "wake") safe(() => agent.followup(message));
      else safe(() => agent.inject(message));
      info(`[lessons] missed-task nudge #${used + 1} for ${sessionId} (calls=${calls}, edits=${edits})`);
    } catch (e) {
      warn(`[lessons] missed-task nudge failed: ${String(e)}`);
    }
  });

  /**
   * 每个 session 至多一个「进行中」的任务。
   * 之所以按 session 分：一个 DSH 进程可能服务多个会话，任务不能串。
   */
  const open = new Map(); // sessionId -> { task }
  /**
   * 最近关闭的任务，供 task_reflect 校验 task_id。
   * 有界：只留最近 20 条，避免长会话无限增长。
   */
  const closed = new Map(); // taskId -> { record, lessonsWritten }
  function rememberClosed(record) {
    closed.set(record.task_id, { record, lessonsWritten: 0 });
    while (closed.size > 20) {
      const oldest = closed.keys().next().value;
      closed.delete(oldest);
    }
  }
  let lastLine = "";

  function writeRecord(rec) {
    lastLine = JSON.stringify(rec);
    return writer.append(`${lastLine}\n`);
  }

  /**
   * 从 tasks.jsonl 重建任务状态（`stateFromFile`）。
   *
   * 重建四类事实：
   *   open        有 open 记录、且没有对应的 close/orphan → 仍在进行中
   *   closed      已关闭的任务及其已写 lesson 数（task_reflect 的校验来源）
   *   everOpened  出现过任何任务记录的会话 → 说明开过任务
   *   nudgeCount  已发出的漏开提醒次数（受 missedTaskMaxPerSession 约束）
   *
   * 只读不改：启动时重建一次，之后由正常写入路径维护内存副本。
   */
  function hydrateStateFromFile() {
    if (!cfg.stateFromFile) return;
    const text = safe(() => lessonStore.readTaskText(), "");
    if (!text) return;

    const opens = new Map(); // taskId -> open 记录
    const endedTaskIds = new Set(); // 已结束（close/orphan）
    const lessonCount = new Map(); // taskId -> 已写 lesson 数
    const closedOrder = []; // 关闭顺序，用于有界截断

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== "object") continue;
      if (typeof rec.session_id === "string" && rec.session_id) everOpened.add(rec.session_id);

      switch (rec.record_type) {
        case "open":
          if (rec.task_id) opens.set(rec.task_id, rec);
          break;
        case "close":
        case "orphan":
          if (rec.task_id) {
            endedTaskIds.add(rec.task_id);
            if (rec.record_type === "close") closedOrder.push(rec);
          }
          break;
        case "reflection": {
          if (rec.task_id) {
            const n = Array.isArray(rec.lessons) ? rec.lessons.length : 0;
            lessonCount.set(rec.task_id, (lessonCount.get(rec.task_id) ?? 0) + n);
          }
          break;
        }
        case "nudge":
          if (rec.session_id) nudgeCount.set(rec.session_id, (nudgeCount.get(rec.session_id) ?? 0) + 1);
          break;
        default:
          break;
      }
    }

    // 进行中：有 open、未结束；同一会话取最后一次 open
    let restoredOpen = 0;
    for (const [taskId, rec] of opens) {
      if (endedTaskIds.has(taskId) || !rec.session_id) continue;
      open.set(rec.session_id, {
        task: {
          task_id: taskId,
          goal: rec.goal,
          expected_result: rec.expected_result,
          start_time: rec.start_time,
          start_seq: rec.start_seq ?? null,
          parent_task_id: rec.parent_task_id ?? null,
          // 决策环境快照：重载后仍要能读回任务开始时生效的经验
          environment: rec.environment ?? null,
        },
      });
      restoredOpen += 1;
    }

    // 可反思：最近 20 条 close
    for (const rec of closedOrder.slice(-20)) {
      closed.set(rec.task_id, {
        record: rec,
        lessonsWritten: lessonCount.get(rec.task_id) ?? 0,
      });
    }

    if (restoredOpen > 0 || closed.size > 0 || everOpened.size > 0) {
      info(
        `[lessons] state restored from file: open=${restoredOpen}, closed=${closed.size}, sessions=${everOpened.size}`
      );
    }
  }

  // 启动即重建：重载后仍能继续已有任务、仍记得哪些会话开过任务。
  hydrateStateFromFile();

  /** 决策环境快照的规模上限：避免单条任务记录无限膨胀。 */
  const ENV_MAX_LESSONS = 12;
  const ENV_FIELD_LIMITS = { problem: 200, attempted: 200, correction: 240, applies_when: 120, omitted: 100 };

  function clipEnv(value, limit) {
    const flat = String(value ?? "").replace(/\s+/g, " ").trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
  }

  /**
   * 快照「任务开始时实际生效的经验」。
   *
   * 为什么在 task_start 而不是 task_end 重算：
   *   - 事后重算会随经验修改而变化，历史任务当时看到的约束就丢了；
   *   - deprecated 的条目会从历史里消失；
   *   - 无法区分「当时注入的」与「事后新增的」；
   *   - 无法追查某条经验是否参与过某次决策。
   *
   * 反思材料因此不只记录「做了什么」，还记录「做的时候受什么约束」。
   *
   * @returns {object|null} 快照；读取失败返回 null（不阻塞任务开启）
   */
  function captureEnvironment(sessionId) {
    try {
      let committedAt = Number.POSITIVE_INFINITY;
      if (batchingOn) committedAt = parseCommitState(lessonStore.readTaskText());
      const { lessons } = lessonStore.read(sessionId, cfg.lessons.scopes, committedAt);
      const all = Array.isArray(lessons) ? lessons : [];

      // ── 截断策略 ──────────────────────────────────────────────────────
      // 旧实现是 `all.slice(0, 12)`：按插入顺序取前 12 条。实测发现被丢的
      // 全是**最新、且全是 high** 的条目 —— 因为 reflection 按写入顺序排列，
      // 越新的越靠后。结果是「最近学到的、最可信的」被系统性丢弃，
      // 只有 oldest 12 条留在快照里，这正是最不该留的那批。
      //
      // 新策略分两步：
      //   1. 排序：high 优先，同级内新的在前（最近学的更可能适用于当前任务）
      //   2. 正文按「预算」截断：先给全部条目各留 id+problem 一行，
      //      剩余预算才用来补 attempted / correction / applies_when
      //
      // 这样即使条目超出上限，也仍能列出**全部 id**（追查依据不丢），
      // 只是每条的信息量下降。
      const sorted = [...all].sort((a, b) => {
        const rank = { high: 0, medium: 1, low: 2 };
        const ra = rank[a.confidence] ?? 1;
        const rb = rank[b.confidence] ?? 1;
        if (ra !== rb) return ra - rb;
        return (b.source?.at ?? 0) - (a.source?.at ?? 0);
      });
      const considered = sorted.slice(0, ENV_MAX_LESSONS);

      const shown = considered.map((l) => ({
        id: l.id,
        scope: l.scope,
        confidence: l.confidence,
        problem: clipEnv(l.problem, ENV_FIELD_LIMITS.problem),
        ...(l.attempted ? { attempted: clipEnv(l.attempted, ENV_FIELD_LIMITS.attempted) } : {}),
        correction: clipEnv(l.correction, ENV_FIELD_LIMITS.correction),
        applies_when: clipEnv(l.applies_when, ENV_FIELD_LIMITS.applies_when),
      }));

      // 未被纳入正文的条目：至少保留 id + problem，供「是否参与过决策」追溯。
      // 不放进 lessons[]（那会撑大材料），而是单独一个精简列表。
      const omitted = sorted.slice(ENV_MAX_LESSONS).map((l) => ({
        id: l.id,
        confidence: l.confidence,
        problem: clipEnv(l.problem, ENV_FIELD_LIMITS.omitted),
      }));

      return {
        taken_at: Date.now(),
        committed_at: committedAt === Number.POSITIVE_INFINITY ? null : committedAt,
        count: all.length,
        truncated: omitted.length > 0,
        lessons: shown,
        ...(omitted.length > 0 ? { omitted } : {}),
      };
    } catch (e) {
      warn(`[lessons] environment snapshot failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 攒批初始化（一次性）。
   *
   * 水位语义：只有 committed_at 之前的反思进 system prompt。没有提交记录时
   * parseCommitState 返回 Infinity（= 全部已提交，向后兼容），那会导致新反思
   * 也被立即注入、pending 永远为空 → 攒批永不触发。
   *
   * 所以首次启用攒批时先写一条 seed 记录，把「此刻之前已有的反思」固定为已提交；
   * 之后新增的反思才会累积成 pending。写完即不再执行（有记录就不再 seed）。
   */
  if (batchingOn) {
    try {
      const existing = lessonStore.readTaskText();
      if (parseCommitState(existing) === Number.POSITIVE_INFINITY) {
        writeRecord({
          record_type: "commit",
          committed_at: Date.now(),
          count: 0,
          reason: "seed",
          recorded_at: Date.now(),
        });
        info("[lessons] commit watermark seeded; batching starts from this point");
      }
    } catch (e) {
      warn(`[lessons] commit seed failed: ${String(e)}`);
    }
  }

  /**
   * Agent 在当前 DSH 里只有 `id`（即 SessionId），没有 `session` 属性。
   * 会话内容一律通过 sessionQuery 读取。
   */
  function sessionIdOf(agent) {
    const id = safe(() => agent?.id, undefined);
    return typeof id === "string" && id ? id : undefined;
  }

  /**
   * 当前会话的实时 seq；用于划定任务区间右端。
   * 经 sessionQuery 异步读取（Agent 只有 id，没有 live Session 句柄）。
   */
  async function currentSeq(agent) {
    const id = sessionIdOf(agent);
    if (!id) return null;
    const events = await readEvents(id);
    const last = events.length > 0 ? events[events.length - 1]?.seq : null;
    return typeof last === "number" ? last : null;
  }

  /**
   * 读某会话的完整事件序列（异步，经 sessionQuery）。
   *
   * **不能用 `listEvents`**：它的返回类型是 `SessionEventRecord`
   * （sessionId / seq / type / time / surface），**没有 `data` 字段**。
   * 用它读事件时 `e.data` 恒为 undefined，于是：
   *   - 决策轨迹永远是空的（对话/纠正/结果全部取不到）
   *   - 「本会话是否开过任务」永远判定为否 → 每回合误报
   *   - 工具失败计数恒为 0
   * 实测：10277 个事件中 1448 个 tool/call 全部缺 name。
   *
   * 正确来源是 `observeSession`（完整 `SessionEvent[]`，live 优先、不重放校验）；
   * 它不可用时回退 `readSession`（完整但会重放校验，较慢）。
   */
  async function readEvents(sessionId) {
    if (!sessionId) return [];
    const q = safe(() => ctx.get("sessionQuery"), undefined);
    if (q === undefined) return [];

    if (typeof q.observeSession === "function") {
      const obs = await safeAsync(() => q.observeSession(sessionId, { projectionMode: "none" }), undefined);
      if (obs !== undefined) {
        try {
          return Array.isArray(obs?.events) ? obs.events : [];
        } finally {
          safe(() => obs?.dispose?.());
        }
      }
    }
    if (typeof q.readSession === "function") {
      const snap = await safeAsync(() => q.readSession(sessionId), undefined);
      if (snap !== undefined && Array.isArray(snap?.events)) return snap.events;
    }
    return [];
  }

  async function safeAsync(fn, fallback) {
    try {
      const v = await fn();
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  async function* noop() {}

  // ── 工具注册 ─────────────────────────────────────────────────────────────
  const tools = safe(() => ctx.get("tools"), undefined);
  if (tools === undefined) {
    warn("[lessons] tools service unavailable; task tools not registered");
    return;
  }

  /**
   * 按 lesson id 展开完整来源。
   *
   * 设计原则：**按需查询，不主动注入**。
   * 决策环境快照里每个条目都带 id，但 id 背后的完整来源（任务目标、结果、
   * 当时的决策轨迹区间、当时生效的其他经验）只在 agent 主动要看时才展开。
   *
   * 数据本来就在 tasks.jsonl 里，这里只做 join：
   *   lesson_id → 前缀即 task_id → open/close/reflection 三段记录
   */
  function lookupLesson(lessonId) {
    const text = safe(() => lessonStore.readTaskText(), "");
    if (!text) return { ok: false, error: "no task records available" };

    const rows = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        /* 坏行跳过 */
      }
    }

    // 1. 定位该 lesson 本身（可能在 reflection 记录里）
    let found;
    let ownerTaskId = null;
    for (const r of rows) {
      if (r.record_type !== "reflection") continue;
      for (const l of r.lessons ?? []) {
        const id = l.lesson_id ?? (r.task_id ? `${r.task_id}#0` : null);
        if (id !== lessonId) continue;
        found = { ...l, assessment: r.assessment, recorded_at: r.recorded_at, session_id: r.session_id };
        ownerTaskId = r.task_id ?? null;
        break;
      }
      if (found) break;
    }

    // 手工维护的条目不在 tasks.jsonl，交给调用方用 list/show 查
    if (!found) {
      // lesson id 常形如 <task_id>#<n>，前缀即来源任务
      const hash = lessonId.indexOf("#");
      const guess = hash > 0 ? lessonId.slice(0, hash) : null;
      if (guess && rows.some((r) => r.task_id === guess)) {
        ownerTaskId = guess;
      } else {
        return { ok: false, error: `unknown lesson id "${lessonId}"` };
      }
    }
    if (!ownerTaskId) {
      const hash = lessonId.indexOf("#");
      ownerTaskId = hash > 0 ? lessonId.slice(0, hash) : null;
    }
    if (!ownerTaskId) return { ok: false, error: `cannot resolve source task for "${lessonId}"` };

    // 2. 取该任务的 open / close / reflection
    const open = rows.find((r) => r.record_type === "open" && r.task_id === ownerTaskId);
    const close = rows.find((r) => r.record_type === "close" && r.task_id === ownerTaskId);
    if (!open && !close) return { ok: false, error: `source task "${ownerTaskId}" not found` };

    // 3. 当时生效的经验（来自 open 记录的快照）
    //    快照分两处：lessons[]（详细）与 omitted[]（只有 id+problem）。
    //    两处都要算，否则「count 说 18 条，只列得出 12 条」。
    const env = open?.environment ?? null;
    const siblings = [
      ...(env?.lessons ?? []),
      // omitted 里的条目信息更少（只有 problem），但同样在生效，不能丢。
      ...(env?.omitted ?? []),
    ]
      .filter((l) => l.id !== lessonId)
      // 兼容：快照可能写于字段拆分之前（那时只有 pattern）。
      .map((l) => ({
        id: l.id,
        confidence: l.confidence,
        problem: l.problem ?? l.pattern ?? "(no description recorded)",
      }));
    const envIds = Array.isArray(close?.environment_ids) ? close.environment_ids : [];

    return {
      ok: true,
      lesson_id: lessonId,
      lesson: found
        ? {
            problem: found.problem ?? found.pattern ?? null,
            attempted: found.attempted ?? null,
            correction: found.correction ?? null,
            applies_when: found.applies_when ?? null,
            confidence: found.confidence ?? null,
            assessment: found.assessment ?? null,
          }
        : null,
      source_task: {
        task_id: ownerTaskId,
        goal: open?.goal ?? close?.goal ?? null,
        expected_result: open?.expected_result ?? close?.expected_result ?? null,
        status: close?.status ?? (open ? "open" : null),
        result: close?.result ?? null,
        start_seq: open?.start_seq ?? close?.start_seq ?? null,
        end_seq: close?.end_seq ?? null,
        start_time: open?.start_time ?? null,
        end_time: close?.end_time ?? null,
        tool_failures: close?.tool_failures ?? null,
        // 决策轨迹的会话区间：用它去会话日志取真实对话
        timeline_hint:
          close?.start_seq != null && close?.end_seq != null
            ? `session events seq ${close.start_seq}..${close.end_seq}`
            : null,
      },
      // 任务开启那一刻还有哪些经验在生效（可用于判断「是不是只有我这一条」）
      // 只详细展开前 10 条，其余仅列 id：不丢可追溯性，也不让输出无限膨胀。
      environment_at_start: env
        ? {
            taken_at: env.taken_at,
            count: env.count,
            others: siblings.slice(0, 10),
            omitted_ids: siblings.slice(10).map((l) => l.id),
          }
        : null,
      // 关闭时记录的完整 id 列表（可用于核对快照是否被截断）
      environment_ids: envIds.slice(0, 50),
    };
  }

  const START_OUTPUT = {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "goal", "expected_result"],
      properties: {
        task_id: { type: "string" },
        goal: { type: "string" },
        expected_result: { type: "string" },
      },
    },
    render: (_args, value) => [
      {
        type: "text",
        text: `Task opened: ${value.task_id}\nGoal: ${value.goal}\nExpected result: ${value.expected_result}\nCall task_end when — and only when — that result exists (or it becomes clear it cannot).`,
      },
    ],
  };

  const END_OUTPUT = {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "status", "review_pending", "tool_failures"],
      properties: {
        task_id: { type: "string" },
        status: { type: "string" },
        review_pending: { type: "boolean" },
        tool_failures: { type: "number" },
      },
    },
    render: (_args, value) => [
      {
        type: "text",
        text:
          `Task closed: ${value.task_id} (${value.status}).` +
          (value.tool_failures > 0 ? ` ${value.tool_failures} tool-level failure(s) noted as auxiliary evidence.` : "") +
          (value.review_pending ? " A review brief for this task follows." : ""),
      },
    ],
  };

  const REFLECT_OUTPUT = {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "lessons_recorded"],
      properties: {
        task_id: { type: "string" },
        lessons_recorded: { type: "number" },
      },
    },
    render: (_args, value) => [
      {
        type: "text",
        text:
          value.lessons_recorded === 0
            ? `Reflection recorded for ${value.task_id}: nothing generalizable beyond this task.`
            : `Reflection recorded for ${value.task_id}: ${value.lessons_recorded} lesson(s).`,
      },
    ],
  };

  tools.register({
    name: "task_start",
    description:
      "Open a task before starting it. A task is a unit of work with a clear goal or expected result that takes one or more steps: work the user asks you to do, work you decide to do, a stage split out of a larger goal, or any request to investigate, analyze, verify, change, organize, or produce something. Do not decide by counting tool calls or steps — when it is unclear whether something is a task, treat it as one. A plain conversational reply, or a single step with no goal of its own, is not a task. Call task_end when the result exists.",
    // 原生注册：parameters 必须是完整 JSON Schema 对象
    // （ctx.tools.register 只做结构校验，不编译 ParameterSchemaSpec）。
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["goal", "expected_result"],
      properties: {
        goal: {
          type: "string",
          description: "What you are about to achieve, in one or two sentences.",
        },
        expected_result: {
          type: "string",
          description:
            "A checkable definition of done: what must be true for this task to count as finished, whether it succeeds or fails.",
        },
        parent_task_id: {
          type: "string",
          description: "Optional: the task_id of the parent task when this is a staged sub-task.",
        },
      },
    },
    output: START_OUTPUT,
    async execute(args, exec) {
      const v = validateStart(args);
      if (!v.ok) throw new Error(v.error);

      const sessionId = sessionIdOf(exec?.agent);
      if (!sessionId) throw new Error("task_start requires an owning agent session");

      // 该会话从此不再需要「漏开任务」提醒
      everOpened.add(sessionId);
      // 旧任务未结束 → 标记 superseded，而不是静默丢弃
      const prev = open.get(sessionId);
      if (prev) {
        const endSeq = await currentSeq(exec.agent);
        const prevTrail = sliceDecisionTrail({
          events: await readEvents(sessionId),
          startSeq: prev.task.start_seq,
          endSeq,
        });
        const prevRecord = buildTaskRecord({
          taskId: prev.task.task_id,
          sessionId,
          goal: prev.task.goal,
          expectedResult: prev.task.expected_result,
          startTime: prev.task.start_time,
          endTime: Date.now(),
          status: TASK_STATUS.ABANDONED,
          result: "(superseded by a new task_start; no result was reported)",
          startSeq: prev.task.start_seq,
          endSeq,
          toolFailures: prevTrail.failureCount,
          parentTaskId: prev.task.parent_task_id,
          closedBy: "superseded",
        });
        writeRecord({ ...prevRecord, ev: "task_close", record_type: "close" });
        rememberClosed(prevRecord);
      }

      const taskId = newTaskId();
      const task = {
        task_id: taskId,
        goal: v.goal,
        expected_result: v.expected,
        start_time: Date.now(),
        start_seq: await currentSeq(exec.agent),
        parent_task_id: typeof args.parent_task_id === "string" && args.parent_task_id.trim() ? args.parent_task_id.trim() : null,
        // 决策环境快照：任务开始时实际生效的经验，冻结在此刻
        environment: captureEnvironment(sessionId),
      };
      open.set(sessionId, { task });

      writeRecord({
        ev: "task_open",
        record_type: "open",
        task_id: taskId,
        session_id: sessionId,
        goal: v.goal,
        expected_result: v.expected,
        start_time: task.start_time,
        start_seq: task.start_seq,
        parent_task_id: task.parent_task_id,
        environment: task.environment,
      });

      return { task_id: taskId, goal: v.goal, expected_result: v.expected };
    },
  });

  tools.register({
    name: "task_end",
    description:
      "Declare that the task's expected result now exists — or that it cannot be reached — and record what actually happened. Ends the task and returns a review brief over the work done between task_start and this call. Call it for every task you opened, whether it succeeded or not.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "status", "result"],
      properties: {
        task_id: {
          type: "string",
          description: "The task_id returned by task_start.",
        },
        status: {
          type: "string",
          enum: ["succeeded", "failed", "abandoned", "aborted"],
          description:
            "succeeded: the expected result exists. failed: it does not, and you know why. abandoned: you stopped pursuing it. aborted: it was interrupted.",
        },
        result: {
          type: "string",
          description: "What actually happened: the concrete outcome, including what was verified.",
        },
      },
    },
    output: END_OUTPUT,
    async execute(args, exec) {
      const v = validateEnd(args);
      if (!v.ok) throw new Error(v.error);

      const sessionId = sessionIdOf(exec?.agent);
      if (!sessionId) throw new Error("task_end requires an owning agent session");

      const state = open.get(sessionId);
      if (!state) throw new Error("no open task for this session; call task_start first");
      if (state.task.task_id !== args.task_id) {
        throw new Error(
          `task_id mismatch: open task is "${state.task.task_id}", got "${args.task_id}"`
        );
      }

      const endSeq = await currentSeq(exec.agent);
      // 以「决策轨迹」为主：对话、纠正、回合；工具失败只计数
      const trail = sliceDecisionTrail({
        events: await readEvents(sessionId),
        startSeq: state.task.start_seq,
        endSeq,
      });

      const record = buildTaskRecord({
        taskId: state.task.task_id,
        sessionId,
        goal: state.task.goal,
        expectedResult: state.task.expected_result,
        startTime: state.task.start_time,
        endTime: Date.now(),
        status: v.status,
        result: v.result,
        startSeq: state.task.start_seq,
        endSeq,
        toolFailures: trail.failureCount,
        parentTaskId: state.task.parent_task_id,
        closedBy: "manual",
      });
      // 与 task_open 对齐：关闭记录也带 record_type，便于按类型筛选。
      // environment_ids 只放 id：用于反查「某条经验参与过哪些任务的决策」，
      // 正文保留在对应的 task_open 记录里，不在此重复。
      writeRecord({
        ...record,
        ev: "task_close",
        record_type: "close",
        environment_ids: (state.task.environment?.lessons ?? []).map((l) => l.id),
      });
      rememberClosed(record);

      // 关闭任务，避免重复结束
      open.delete(sessionId);

      // 反思材料只挂在本轮，通过 additionalContexts 进入下一步。
      // 环境快照是否渲染由 environmentInBrief 控制；记录本身始终写入 task_open。
      const brief =
        cfg.injectReflection && trail.stats.events > 0
          ? renderReflectionBrief({
              task: record,
              trail,
              environment: cfg.environmentInBrief ? state.task.environment : null,
              silent: cfg.silentReflection,
            })
          : undefined;
      if (brief) {
        safe(() => exec.deferContext?.(makeContextMessage(brief, record.task_id)));
      }
      writer.sync();

      return {
        task_id: record.task_id,
        status: record.status,
        review_pending: Boolean(brief),
        tool_failures: record.tool_failures,
      };
    },
  });

  tools.register({
    name: "task_reflect",
    description:
      "Record what you concluded from reviewing a closed task. Each lesson describes a reusable pattern in how you worked and the adjustment it calls for — not what a specific tool did. If nothing generalizes beyond this task, pass an empty lessons array.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id", "assessment"],
      properties: {
        task_id: {
          type: "string",
          description: "The task_id of the closed task you reviewed.",
        },
        assessment: {
          type: "string",
          enum: ["aligned", "partial", "diverged"],
          description:
            "How the actual result compared to the expected result: aligned, partial, or diverged.",
        },
        source: {
          type: "string",
          description:
            "Where this experience came from, in your own words: the situation or mistake that produced it (e.g. 'npx 拉错了同名包' or '修 cart 别名 bug 时才发现的'). Keep it factual and short; it is kept as provenance, not injected.",
        },
        lessons: {
          type: "array",
          description: "At most three; omit or pass an empty array when nothing transfers to future work.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["problem", "correction", "applies_when"],
            properties: {
              problem: {
                type: "string",
                description:
                  "What actually happened — the observable symptom or mistake, e.g. 'the file read back as mojibake'. Describe the event, not the fix.",
              },
              attempted: {
                type: "string",
                description:
                  "What you did about it at the time, e.g. 'decoded again without changing the encoding'. State the action plainly; do not evaluate it here.",
              },
              correction: {
                type: "string",
                description:
                  "What should be done instead, e.g. 'read with UTF-8'. This must not be narrower than problem: if the fix says less than the problem describes, one of them is wrong.",
              },
              applies_when: {
                type: "string",
                description: "The situation that should trigger this correction.",
              },
              confidence: {
                type: "string",
                enum: ["low", "medium", "high"],
                description: "Defaults to medium.",
              },
              relation: {
                type: "string",
                enum: ["new", "repeat", "revise", "none"],
                description:
                  "How this lesson relates to what is already recorded: new (not seen before), repeat (the same lesson again — counts as evidence, no new entry), revise (this replaces the existing lesson named by target), none (adds nothing, not stored). Defaults to new.",
              },
              target: {
                type: "string",
                description:
                  "The lesson_id being repeated or revised. Required when relation is repeat or revise.",
              },
              conflicts: {
                type: "array",
                description:
                  "Explicit tension with another memory you can already see. This declares a relationship; it does not resolve it. Both memories stay in force and the reviewer decides per situation.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["with", "kind"],
                  properties: {
                    with: {
                      type: "string",
                      description: "The lesson_id this one is in tension with.",
                    },
                    kind: {
                      type: "string",
                      enum: ["condition", "goal", "contradiction", "apparent"],
                      description:
                        "condition: they apply in different environments. goal: they demand different behaviors. contradiction: opposite demands under the same condition. apparent: one is a general rule and the other a specific exception.",
                    },
                    note: {
                      type: "string",
                      description: "Optional one-line explanation of the tension.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    output: REFLECT_OUTPUT,
    async execute(args, exec) {
      const v = validateReflect(args);
      if (!v.ok) throw new Error(v.error);

      const entry = closed.get(v.taskId);
      if (!entry) {
        const known = [...closed.keys()].slice(-5);
        throw new Error(
          `unknown or expired task_id "${v.taskId}"; recently closed tasks: ${known.length ? known.join(", ") : "(none)"}`
        );
      }

      const sessionId = sessionIdOf(exec?.agent);
      const offset = entry.lessonsWritten;

      // `none` 不落盘：无新增信息的反思不占用后续注入预算（治理规范 §2.1）
      const written = v.lessons.filter((l) => l.relation !== "none");
      entry.lessonsWritten += written.length;
      if (written.length > 0) {
        writeRecord(buildReflectionRecord({
          taskId: v.taskId,
          sessionId,
          assessment: v.assessment,
          source: v.source,
          lessons: written,
          offset,
        }));
      }


      // ── 反思即时注入 + 攒批提交（方案 B）──────────────────────────────────
      // 实测依据（cache-probe/controlled.mjs）：
      //   plugin 类注入 20/20 样本缓存命中率 >= 99.6%
      //   system/message 变更 8/8 样本命中率 <= 0.7%
      // 所以：新教训先即时通知（零缓存代价），攒够再推进水位让 section 变一次。
      if (instantNoticeOn && written.length > 0) {
        try {
          const taskText = lessonStore.readTaskText();
          const committedAt = parseCommitState(taskText);
          const pending = pendingReflections({ taskText, sessionId, committedAt });
          const decision = shouldCommit({
            pendingLessons: pending,
            maxPending: cfg.lessons.commitEvery,
            maxPendingTokens: cfg.lessons.commitEveryTokens,
          });

          if (decision.due) {
            // 推进水位：写入提交记录，下一次装配才会把 pending 并进 section
            const committedAtNew = Date.now();
            writeRecord({
              record_type: "commit",
              committed_at: committedAtNew,
              count: pending.length,
              reason: decision.reason,
              session_id: sessionId,
              recorded_at: committedAtNew,
            });
            if (exec?.deferContext) {
              exec.deferContext(makeNoticeMessage(
                `<lessons_committed count="${pending.length}" reason="${decision.reason}">` +
                  "\n" +
                  `${pending.length} lesson(s) have been folded into the system prompt's Accumulated Lessons.` +
                  "\n" +
                  "They are no longer repeated here. New reflections will be announced individually from now on." +
                  "\n" +
                  `</lessons_committed>`,
                `lessons committed: ${pending.length}`
              ));
            }
            diagnostics({ ts: committedAtNew, kind: "commit", count: pending.length, reason: decision.reason });
          } else {
            const text = renderInstantNotice({
              lessons: written,
              taskId: v.taskId,
              assessment: v.assessment,
              pendingCount: pending.length,
            });
            if (exec?.deferContext && text) exec.deferContext(makeNoticeMessage(text, `new lessons: ${written.length}`));
            diagnostics({ ts: Date.now(), kind: "instant", count: written.length, pending: pending.length });
          }
        } catch (e) {
          warn(`[lessons] instant notice failed: ${String(e)}`);
        }
      }

      return { task_id: v.taskId, lessons_recorded: written.length };
    },
  });

  // ── 按需查询：经验的完整来源 ──────────────────────────────────────────────
  // 刻意不做主动注入。决策材料和 system prompt 里只给 id，
  // 想追查时由 agent 自己决定调用——避免每次都把历史塞进上下文。
  tools.register({
    name: "lessons_lookup",
    description:
      "Trace one recorded lesson back to the task that produced it: what the task was trying to achieve, what actually happened, and which other lessons were in force at that moment. Use this when a lesson's applicability or origin is unclear, or when you need to judge whether it still holds. Read-only; it records nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["lesson_id"],
      properties: {
        lesson_id: {
          type: "string",
          description:
            "The exact lesson id, as shown in the decision environment ([E1] etc.) or in the system prompt's Accumuated Lessons.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["found"],
        properties: {
          found: { type: "boolean" },
          summary: { type: "string" },
          error: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.summary ?? value.error ?? "" }],
    },
    execute(args) {
      const id = typeof args?.lesson_id === "string" ? args.lesson_id.trim() : "";
      if (!id) throw new Error("lesson_id is required");

      const r = lookupLesson(id);
      if (!r.ok) return { found: false, error: r.error };

      const L = [];
      L.push(`LESSON ${r.lesson_id}`);
      if (r.lesson) {
        L.push(`  problem:     ${r.lesson.problem ?? "(unknown)"}`);
        if (r.lesson.attempted) L.push(`  attempted:   ${r.lesson.attempted}`);
        if (r.lesson.correction) L.push(`  correction:  ${r.lesson.correction}`);
        if (r.lesson.applies_when) L.push(`  applies when: ${r.lesson.applies_when}`);
        if (r.lesson.confidence) L.push(`  confidence:  ${r.lesson.confidence}`);
        if (r.lesson.assessment) L.push(`  assessment:  ${r.lesson.assessment}`);
      } else {
        L.push("  (manually maintained entry; body is in lessons.jsonl — use the CLI `show`)");
      }
      L.push("");
      const t = r.source_task;
      L.push(`SOURCE TASK ${t.task_id}`);
      if (t.goal) L.push(`  goal:     ${t.goal}`);
      if (t.expected_result) L.push(`  expected: ${t.expected_result}`);
      if (t.status) L.push(`  status:   ${t.status}`);
      if (t.result) L.push(`  result:   ${t.result}`);
      if (t.timeline_hint) L.push(`  timeline: ${t.timeline_hint}`);

      if (r.environment_at_start) {
        const e = r.environment_at_start;
        L.push("");
        L.push(`OTHER LESSONS IN FORCE WHEN THAT TASK STARTED (${e.count} total):`);
        if (e.others.length === 0) L.push("  (none besides this one)");
        for (const o of e.others) L.push(`  [${o.id}] (${o.confidence}) ${o.problem}`);
        if (e.omitted_ids?.length) {
          L.push(`  (+${e.omitted_ids.length} more in force, not expanded: ${e.omitted_ids.join(", ")})`);
        }
      }

      return { found: true, summary: L.join("\n") };
    },
  });

  const END_MARK = "lessons_task_closed";
  let ctxSeq = 0;
  /** 构造一条注给模型看的通知消息（role=user + 插件 source）。 */
  function makeNoticeMessage(text, summary) {
    ctxSeq += 1;
    return {
      id: `plugin:lessons:${Date.now().toString(36)}:${ctxSeq}`,
      role: "user",
      content: [{ type: "text", text }],
      source: {
        kind: "plugin:lessons",
        form: "notice",
        summary: String(summary ?? "").slice(0, 120),
      },
    };
  }
  function makeContextMessage(text, taskId) {
    return makeNoticeMessage(text, `task closed: ${taskId}`);
  }

  // 卸载：落盘并封存仍开着的任务（会话结束时它们没有结果）
  ctx.effect(
    () => () => {
      try {
        // stateFromFile 开启时不写 orphan。
        //
        // orphan 的语义是「这个任务不会再被结束了」。但开启文件推导后，卸载通常
        // 只是插件重载：任务应该保持「进行中」，下次启动从文件恢复后继续。
        // 若无条件写 orphan，重载本身就会把任务标记为已结束，
        // 「重载后继续做」的能力直接失效（实测踩过三次）。
        if (!cfg.stateFromFile) {
          for (const [sessionId, state] of open) {
            writeRecord({
              ev: "task_orphaned",
              record_type: "orphan",
              task_id: state.task.task_id,
              session_id: sessionId,
              goal: state.task.goal,
              expected_result: state.task.expected_result,
              start_time: state.task.start_time,
              start_seq: state.task.start_seq,
              closed_by: "session-end",
            });
          }
        }
        open.clear();
      } catch {
        /* ignore */
      }
      try {
        writer.close();
      } catch {
        /* ignore */
      }
    },
    "lessons.writer"
  );

  info(`[lessons] mounted; tasks -> ${join(cfg.taskDir, "tasks.jsonl")}`);
}

export const internals = { readConfig, validateStart, validateEnd };

