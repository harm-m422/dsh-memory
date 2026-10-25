# dsh-memory

一个**带作用域的记忆体**，所有任务共用。它取代了 `dsh-diary`：不是把日记改名，而是换掉了
"谁来都看同一页"的扁平模型。

## 为什么换

扁平模型的毛病：三块档案永远全上、日志只看最新 6 条。结果是不管你在聊天、改车还是改插件，
拿到的都是同一份——有用的被最新 6 条挤掉，不相关的一直占着。

记忆要**按场景取用**。所以有了作用域。

## 四类作用域

| 作用域 | 装什么 | 什么时候进上下文 |
|---|---|---|
| `world` | 我的性格、你的性格、这套 harness 的构成 | 永远，压成一行 |
| `topic:名` | 一条长期线：上次到哪、哪条结论是决定性的 | 会话绑定了这个 topic 时 |
| `file:路径` | 某个文件/工程的上次工作记录 + 地址 | 会话碰过这个文件时 |
| `session:当前` | 这次对话的方向 | 永远（属于本会话） |

于是：

- **聊天** → 我的性格 + 你的性格 + 上次聊的方向
- **做任务** → 风格 + 教训 + 这个文件上次的记录 + 地址

两条线之间不会串味。

## 绑定是自动的

不用谁记得去登记：

- **写/读一个作用域** → 该作用域绑到本会话
- **碰文件** → `tools.guard` 在 `read / write / edit / glob / grep` 时从参数里取路径，
  把 `file:路径` 绑上

`session:current` 会解析成调用者自己的会话 id，所以 agent 不需要知道自己的 id。

## 技术上为什么成立

`dsh-agent` 的 `assembleContextFor` 把活着的 Agent 传进每个 prompt context：

```js
function assembleContextFor(agent, signal) {
  return { agent, scope: agent, ...(signal === void 0 ? {} : { signal }) }
}
```

声明类型 `AssembleContext` 里只写了 `scope`，所以代码对 `context.agent` 是防御式读取：
拿不到就退化成只有 `world`，仍然是正确的，只是不够具体。

## 预算

整个记忆块硬上限 **1800 字符**，按优先级填：world → 当前 session → 绑定的 topic/file
（最近的先）。单个作用域块放不下就整个跳过，不留半截。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_write` | 往某个作用域记一条日志 |
| `memory_read` | 按作用域/类型/关键词翻（`includeDeleted` 看隐藏的） |
| `memory_forget` | 删日志：`ids` / `keep` / `query` 三选一，默认隐藏，`purge` 才真删 |
| `memory_fact` | 读写删档案事实（`action=read/write/delete`） |

## 存储

沿用 `~/.dsh/diary/`，所以从 dsh-diary 升级**没有迁移步骤**：

```
$DSH_HOME/diary/profiles.json      # 事实；键 `slot` = world，`scope::slot` = 作用域
$DSH_HOME/diary/entries.jsonl      # 日志；无 scope 字段 = world
$DSH_HOME/diary/bindings.json      # { <会话id>: { scopes: [...] } }
$DSH_HOME/diary/state.json         # { lastId: n } —— id 下限，删了也不复用
```

日志 `id` 由进程内单调计数器发放，下限落盘。删掉 #15 之后下一条是 #16，不是 #15——
否则对话里那些 "#12" 的指代就全乱了。

浏览器里看：`http://127.0.0.1:3080/dsh-memory/state`（JSON 概览）、
`/dsh-memory/text`（纯文本全量）。需要同一浏览器的登录态。

## 为什么结尾必须去掉 `{{`

`systemPrompt.context` 的文本会被扫描成 `{{变量}}` 引用，而 `PromptContext` **没有**
`interpolate: false` 退出开关（只有 `PromptSection` 有）。记忆正文是任意的，一条带 `{{`
的记录会让每次提示词组装抛错——整个进程的请求全挂。所以进提示词之前把 `{{` 换成 `{ {`。

## 两个模型，一条线路

记忆的**整理**不占用主模型的脑子，交给一个专门的记忆模型（`deepseek-flash`，api.deepseek.com，
OpenAI 协议）。主模型只管干活和汇报。

```
每轮：
  我干活 → memory_report(这一轮做了什么)
        → 记忆模型整理 → 一级记忆落库
        → 我再向用户汇报          ← 顺序不能反

重要时：
  memory_promote(决定性结论) → 记忆模型深度整理 → 二级记忆落库
```

实测：一级整理约 2 秒，二级整理约 3 秒。都验证过**主动去重**——
喂一条与已有记忆重复的结论时，它回的是「与 #1 完全一致，故不新增条目」，不是硬记一条。

`model.js` 是那个客户端，整个设计是**软失败**的：接口不可用、超时、返回散文而不是 JSON，
都不抛进这一轮，只报告「这轮没整理」。记忆是优化，不是依赖。

API key 从 `DSH_MEMORY_API_KEY` 读，其次 `~/.dsh/memory/key`（0600）。

## 分层与作用域是两个轴

作用域回答「这是谁的记忆」，层级回答「多难被改」。两者正交：

| 层级 | 内容 | 默认来自 |
|---|---|---|
| `persona` | 说话方式、办事风格 | world 的 `agent` / `user` |
| `deep` | 二级：几个月后还成立的结论 | 其他 world 事实、`memory_promote` 的产物 |
| `note` | 一级：一条线的当前状态 | topic / file 事实与日志 |
| `ephemeral` | 本次对话 | `session:` 作用域 |

上下文按 性格 → 二级 → 一级 → 本次对话 的顺序填，硬上限 1800 字符。

**世界层的日志条目不会自动注入。** 只注入绑定到本会话的 topic/file 条目和本会话条目；
否则全世界的旧日志又会在每个会话里漫出来，那就退回扁平的毛病了。世界条目用
`memory_read` 查。

## 安装与生效

包在 `~/.dsh/profiles/web/node_modules/dsh-memory/`，`cordis.patch.yml` 里一行
id 为 `memory` 的 insert。**新包名 = 新模块 URL = 不重启也能挂上**（实测：加行后
`/dsh-memory/state` 立刻从 404 变 401）。改已加载包的 `index.js` 仍然必须重启。

手工装（不需要 pnpm）：

```bash
git clone https://github.com/harm-m422/dsh-memory.git
cp -a dsh-memory ~/.dsh/profiles/web/node_modules/dsh-memory
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'
- insert:
    - id: memory
      name: dsh-memory
EOF
```

数据落在 `$DSH_HOME/diary/`（沿用 dsh-diary 的老目录，升级没有迁移步骤）。设置 → **记忆**
是面板入口。记忆模型要一个 API key：`export DSH_MEMORY_API_KEY=...`，或写进
`~/.dsh/memory/key`（0600）。不给也能用，只是这一轮不会被整理。


## 设置页（面板）

设置 → **记忆**（大脑图标）。四块：

1. **记忆模型** —— 改模型 id、思考三态（自动 / 强制开 / 关）。实测这个接口的
   `reasoning_effort` 基本无效，`thinking: {type}` 看起来能压掉推理，所以只给三态，不给骗人的档位。
2. **每轮耗时** —— 平均毫秒、总调用次数、最近一次，并按类型拆分（一级整理 / 二级整理 / 面板对话 / 失败）。
3. **接入记忆框架的档** —— 作用域数、事实数、日志数、会话数，默认折叠，展开看每个作用域的明细。
4. **和记忆模型说话** —— 问它记了什么。要改记忆时它先用口语要一个理由。

**理由闸门是双层的**：提示词要求它没理由不许改，而且宿主会把任何没带理由的改动提案直接丢掉，
不管模型返回什么。理由最终写在那条被改的记录上。

**对话不留存**：消息只活在组件状态里，关掉页面就没了。只有「带理由并且真的被改过」的记忆会留下。

接口：`GET /dsh-memory/panel`、`POST /dsh-memory/config`、`POST /dsh-memory/chat`。

> 注：`/dsh-memory` 是前缀路由且先过鉴权，所以**从外部无法用 404/401 判断某个子路径是否存在**——
> 只要插件挂着，任何 `/dsh-memory/*` 都先 401。验证面板只能真的打开页面看。

## 许可

MIT，见 [LICENSE](LICENSE)。版权人 harm-m422。

这个插件运行在 **DeepSeek Harness** 里，用的是它的公开扩展点（工具注册、提示词段与
prompt context、web server 路由与鉴权）；DSH 本身也是 MIT（Copyright (c) 2026 DeepSeek）。
README 里引用的 `assembleContextFor` 片段属于 DSH 源码，按同一份 MIT 授权引用。第三方出处
见 [NOTICE](NOTICE)。

