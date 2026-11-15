**dsh-memory**

*当前版本* ***2.0.2+***

一个**带作用域的记忆体**，所有任务共用。它取代了 `dsh-diary`：不是把日记改名，而是换掉了  
   
 "谁来都看同一页"的扁平模型。

**2.0 新在哪**

这一版跳大版本，因为有两处是**行为变了**，不是修 bug。

**两种梦**

细节见下面「做梦」整节：

- **整理梦**：重建索引（`index.jsonl` / `terms.json` / `timeline.md`），并把同作用域里说同一件事的条目合并。频率照旧是掷色子，每周至少两次。
- **练习梦**：模型给自己出题、只依据记忆作答，在沙盒里积累经验。每 10 天一次，只在非上班时段（工作日 9–12 / 14–18 之外，含法定节假日与调休上班日判断）、系统负载低于一半、且 harness 空闲时开始；单次预算 200 万 token。

**人设终于进得来**

persona 档（`world/agent`、`world/user`）的注入上限 **90 → 700 字**，整块上限 **1800 → 2400**。

之前那份 654 字的自我描述，每轮只进去前 90 字——【爱好】【毛病】【底线】从来没被模型看到过。写了读不到，等于没写。

`memory_fact` **可以只改一句**

新增 `action: "edit"`，配 `find` / `replace`：

- `find` 必须在原文里**唯一出现**
- 0 次 → 「没动」，多次 → 直接报错拒绝（防止改错地方）
- 其余字节原样写回，写之前照常留 `profiles.json.bak`

**索引是给人读的，不参与检索**

索引按 **60 字摘要** 建词表，查不到正文里的词。实测 5000 条全量解析只要 6ms，用索引省的那两三毫秒换来漏检不划算——所以 `memory_read` 仍然全量扫，索引只用来给人看（`timeline.md`）和给 `memory_dream status` 当线索。

**设置页「做梦」**

整理梦开关 + 每周 1–4；练习梦开关 + 每 7/10/14/30 天；下次时间；预算；「现在整理」「现在练一次」；最近几条经验。

**顺手修掉的**

- 密文条目的 `text` 是对象（`{enc,iv,tag,data}`），曾被当成空串：索引里变空白行、`sealed` 计数永远是 0
- 面板摘要每条事实 220 字 → 800 字（人设以前在面板里也只露半截）
- 恍惚退旧后报数按落盘条数算（以前报 106，文件里只有 60）

---

**为什么换**

扁平模型的毛病：三块档案永远全上、日志只看最新 6 条。结果是不管你在聊天、改车还是改插件，  
   
 拿到的都是同一份——有用的被最新 6 条挤掉，不相关的一直占着。

记忆要**按场景取用**。所以有了作用域。

**四类作用域**

|  |  |  |
| - | - | - |
| **作用域** | **装什么** | **什么时候进上下文** |
| `world` | 我的性格、你的性格、这套 harness 的构成 | 永远，压成一行 |
| `topic:名` | 一条长期线：上次到哪、哪条结论是决定性的 | 会话绑定了这个 topic 时 |
| `file:路径` | 某个文件/工程的上次工作记录 + 地址 | 会话碰过这个文件时 |
| `session:当前` | 这次对话的方向 | 永远（属于本会话） |

 

于是：

- **聊天** → 我的性格 + 你的性格 + 上次聊的方向
- **做任务** → 风格 + 教训 + 这个文件上次的记录 + 地址

两条线之间不会串味。

**绑定是自动的**

不用谁记得去登记：

- **写/读一个作用域** → 该作用域绑到本会话
- **碰文件** → `tools.guard` 在 `read / write / edit / glob / grep` 时从参数里取路径，  
     
   把 `file:路径` 绑上

`session:current` 会解析成调用者自己的会话 id，所以 agent 不需要知道自己的 id。

**技术上为什么成立**

`dsh-agent` 的 `assembleContextFor` 把活着的 Agent 传进每个 prompt context：

```
function assembleContextFor(agent, signal) {
   return { agent, scope: agent, ...(signal === void 0 ? {} : { signal }) }
 }
 
```

声明类型 `AssembleContext` 里只写了 `scope`，所以代码对 `context.agent` 是防御式读取：  
   
 拿不到就退化成只有 `world`，仍然是正确的，只是不够具体。

**预算**

整个记忆块硬上限 **1800 字符**，按优先级填：world → 当前 session → 绑定的 topic/file  
   
 （最近的先）。单个作用域块放不下就整个跳过，不留半截。

**做梦**

两种，性质完全不同。产物都落在 `diary/dream/`。

**整理梦（tidy）**——记忆文件自己总结、自己重排。

- `index.jsonl`：每条一行（id / 时间 / 作用域 / 类型 / 60 字摘要 / 字节偏移）
- `terms.json`：字符二元组倒排，检索先查它
- `timeline.md`：按作用域分组的可读时间线
- 索引是派生物，随时可重建；密文条目只记「（加密条目）」，不建词条——摘要一旦落盘就是明文泄漏
- 合并重复：同 `scope+kind` 内按二元组重合 ≥45% 聚类，**只许合并**（合并句须与原材料 ≥34% 有根），合并结果不新增内容
- 重写走 `writeEntries`：先落 `.bak`，`.tmp` 原子替换，密文与坏行原样带过；被并掉的原文进 `merged.jsonl`
- 频率：每个自然周掷色子至少两次（欠账只滚一次，失败退避 2h）

**练习梦（practice）**——模型给自己出题，按记忆回答，在模拟里积累经验。

- 每 10 天一次
- 只在：**不在**北京时间工作日 09:00–12:00 / 14:00–18:00（内置 2026 国务院放假表，**调休上班日按工作日算**）；`loadavg/核数 < 0.5`；距上次上下文装配 ≥5 分钟
- 预算：一次最多 200 万 token，按每次调用的 `usage.totalTokens` 累加，调用前检查
- 三道题：A 细节题 / B 得拼几条记忆 / C 写个小项目（代码只写进 `dream/sandbox/`，不执行）
- 可以写 `<<read 路径>>` 当只读工具：限工作区或记忆目录、单次 ≤8KB、最多两次
- 经验写 `experience.jsonl`，**单独存、不进真实记忆**；每轮最多注入 2 条，并标明「来自模拟环境，不是事实」

**推理预算**：这个模型默认会把大量 token 花在思考上。实测一道「写脚本」题，3200 上限下  
   
 推理吃掉 10,660 字符、正文 0 字，`finish` 是 `max-tokens`——看起来像"模型没回答"，其实是  
   
 预算被思考吃完了。所以默认 `effort: "low"`（`off` / `low` / `high` 有效），provider 不认就  
   
 自动退成不指定；C 类题的正文预算单独给到 6000。

**索引不参与检索。** 它是 60 字摘要建的，查不到正文里的词；实测 5000 条全量解析只要 6ms，  
   
 用索引省下的两三毫秒换来漏检不划算，所以 `memory_read` 仍然全量扫。索引的用处是给人读  
   
 （`timeline.md`）、给 `memory_dream status` 当线索。

入口：工具 `memory_dream`（`status` / `tidy` / `practice` / `read`），路由 `/dsh-dream/{status,run,config}`，  
   
 开关与参数在 `diary/dream.json`。

**工具**

|  |  |
| - | - |
| **工具** | **作用** |
| `memory_write` | 往某个作用域记一条日志 |
| `memory_read` | 按作用域/类型/关键词翻（`includeDeleted` 看隐藏的） |
| `memory_search` | 从一个模糊问题检索：先拆词，再在本地匹配日志与事实 |
| `memory_forget` | 删日志：`ids` / `keep` / `query` 三选一，默认隐藏，`purge` 才真删 |
| `memory_fact` | 读写改删常驻事实：`action=read/write/edit/delete`。**`edit` 是 2.0 新增**，只替换原文里唯一的一段 |
| `memory_report` | 每轮汇报，交给记忆模型整理成一级记忆 |
| `memory_promote` | 把决定性结论深度整理进二级 |
| `memory_persona` | 八面性格档案；ACC 引擎下是 `acc_persona` |
| `memory_vivid` | 记一件值得日后忽然想起的事（有意思 / 尴尬） |
| `memory_archive` | 把完整会话归档（多帧 zstd，不截断） |
| `memory_recall` | 按记得的词回查归档原文 |
| `memory_dream` | **2.0 新增**：`status` / `tidy` / `practice` / `read` |

 

**存储**

沿用 `~/.dsh/diary/`，所以从 dsh-diary 升级**没有迁移步骤**：

```
$DSH_HOME/diary/profiles.json      # 事实；键 `slot` = world，`scope::slot` = 作用域
 $DSH_HOME/diary/entries.jsonl      # 日志；无 scope 字段 = world
 $DSH_HOME/diary/bindings.json      # { <会话id>: { scopes: [...] } }
 $DSH_HOME/diary/state.json         # { lastId: n } —— id 下限，删了也不复用
 $DSH_HOME/diary/usage.json         # 每轮耗时统计（设置页的「每轮耗时」）
 $DSH_HOME/diary/dream.json         # 做梦开关与参数（整理梦/练习梦/预算/推理档）
 $DSH_HOME/diary/dream/             # index.jsonl / terms.json / timeline.md / stats.json
                                    # merged.jsonl（被并掉的原文） / experience.jsonl / sandbox/
 
```

日志 `id` 由进程内单调计数器发放，下限落盘。删掉 #15 之后下一条是 #16，不是 #15——  
   
 否则对话里那些 "#12" 的指代就全乱了。

浏览器里看：`http://<host>:<port>/dsh-memory/state`（JSON 概览）、  
   
 `/dsh-memory/text`（纯文本全量）。需要同一浏览器的登录态。

**为什么结尾必须去掉** `{{`

`systemPrompt.context` 的文本会被扫描成 `{{变量}}` 引用，而 `PromptContext` **没有**  
   
 `interpolate: false` 退出开关（只有 `PromptSection` 有）。记忆正文是任意的，一条带 `{{`  
   
 的记录会让每次提示词组装抛错——整个进程的请求全挂。所以进提示词之前把 `{{` 换成 `{ {`。

**两个模型，一条流程**

记忆的**整理**不占用主模型的脑子，交给一个专门的记忆模型（`deepseek-flash`，api.deepseek.com，  
   
 OpenAI 协议）。主模型只管干活和汇报。

```
每轮：
   我干活 → memory_report(这一轮做了什么)
         → 记忆模型整理 → 一级记忆落库
         → 我再向用户汇报          ← 顺序不能反
 
 重要时：
   memory_promote(决定性结论) → 记忆模型深度整理 → 二级记忆落库
 
```

实测：一级整理约 2 秒，二级整理约 3 秒。都验证过**主动去重**——  
   
 喂一条与已有记忆重复的结论时，它回的是「与 #1 完全一致，故不新增条目」，不是硬记一条。

`model.js` 是那个客户端，整个设计是**软失败**的：接口不可用、超时、返回散文而不是 JSON，  
   
 都不抛进这一轮，只报告「这轮没整理」。记忆是优化，不是依赖。

API key 从 `DSH_MEMORY_API_KEY` 读，其次 `~/.dsh/memory/key`（0600）。

**分层与作用域是两个轴**

作用域回答「这是谁的记忆」，层级回答「多难被改」。两者正交：

|  |  |  |
| - | - | - |
| **层级** | **内容** | **默认来自** |
| `persona` | 说话方式、办事风格 | world 的 `agent` / `user` |
| `deep` | 二级：几个月后还成立的结论 | 其他 world 事实、`memory_promote` 的产物 |
| `note` | 一级：一条线的当前状态 | topic / file 事实与日志 |
| `ephemeral` | 本次对话 | `session:` 作用域 |

 

上下文按 性格 → 二级 → 一级 → 本次对话 的顺序填，硬上限 1800 字符。

**世界层的日志条目不会自动注入。** 只注入绑定到本会话的 topic/file 条目和本会话条目；  
   
 否则全世界的旧日志又会在每个会话里漫出来，那就退回扁平的毛病了。世界条目用  
   
 `memory_read` 查。

**安装与生效**

包在 `~/.dsh/profiles/web/node_modules/dsh-memory/`，`cordis.patch.yml` 里一行  
   
 id 为 `memory` 的 insert。**新包名 = 新模块 URL = 不重启也能挂上**（实测：加行后  
   
 `/dsh-memory/state` 立刻从 404 变 401）。改已加载包的 `index.js` 仍然必须重启。

**设置页（面板）**

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

*注：`/dsh-memory` 是前缀路由且先过鉴权，所以****从外部无法用 404/401 判断某个子路径是否存在***—*—*  
   
 *只要插件挂着，任何 `/dsh-memory/*` 都先 401。验证面板只能真的打开页面看。*

**API key 的读写边界**

`POST /dsh-memory/key { key }`：写入 `~/.dsh/memory/key`（`mode: 0o600` + `chmod`），  
   
 空字符串则删除该文件；不足 8 字符返回 400。

**只写不读。** 响应只有 `{ keySet, keyFromEnv }`，`/panel` 也只回 `keySet` 和路径，  
   
 任何接口都不会把 key 吐出来。`apiKey()` 每次调用读文件、不缓存，所以保存后立刻生效。

环境变量 `DSH_MEMORY_API_KEY` 优先级高于文件；`/panel` 用 `keyFromEnv` 把这件事告诉页面，  
   
 免得"保存了但没效果"变成一个谜。
