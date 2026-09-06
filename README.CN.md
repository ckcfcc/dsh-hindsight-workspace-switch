# dsh-hindsight-workspace-switch

[English](./README.md) | [中文](./README.CN.md)

给 DeepSeek Harness（dsh）的会话输入区加一个**按工作区**的 HindSight 开关：在模型选择器的左边显示一个 switch，打开即为「禁用 HindSight」。没装 HindSight 时不显示这个开关。

## 它怎么做到真正的关闭

HindSight 的 `dist/dsh.js` 是一个普通 Cordis 插件，它做四件事，四件都是**注册**：

| 它注册的 | 作用 |
| --- | --- |
| `agent/session-start` 监听 | 首次开会话时播种记忆库 |
| `agent/pre-step` 监听 | 召回记忆并注入上下文 |
| `agent/turn-stopping` 监听 | 会话结束时把整段对话写回 bank |
| `ctx.tools` 上的 `hindsight_*` 工具 | 显式存取知识 |

Cordis 的注册是**可逆的效果**，而且 dsh 的分派是按 scope 过滤的：把插件挂到某个 agent 的作用域上下文 `agent.ctx` 上，这四件事就只属于这个 agent；销毁这个挂载，四件事一起消失。所以本插件不是去「拦」HindSight，而是**接管挂载权**：

- 本插件占据 `hindsight` 这一行，自己 `import` 原来的 `dist/dsh.js`；
- 每个 agent 创建时，按它所属工作区查开关状态，只在**未禁用**的工作区把 HindSight 挂到 `agent.ctx` 上；
- 切换开关时，该工作区正在跑的会话**立即**卸载/挂载，不需要等下一次开会话。

「禁用」的完整含义：不召回、不写回、不注册 `hindsight_*` 工具。

## 打开开关后到底变了什么

三件事，发生在三条不同的时间线上。把它们分开，几乎所有反直觉的现象都能解释清楚。

### 1. 工具立刻消失

所有 `hindsight_*` 工具会**立即**从工具定义里掉出去——包括正在运行的会话，不只是新开的会话。在 composer 的上下文查看器里，这表现为**工具定义**分组上出现一个负数增量（典型 HindSight 安装下是 `-8`）。

这是最快、最直观的效果，而且**对本次会话的剩余部分是永久的**：工具定义每次装配时都从注册表重新读取，所以挂载一旦销毁，它们就不会再回来。

### 2. 不再产生新的召回

卸载同时会解绑执行召回的 `agent/pre-step` 监听器，所以从那一刻起**不再产生新的** `<hindsight_knowledge>` 块。开关打开之后新开的会话是完全干净的。

### 3. 已经在日志里的块会被清除——但不是靠卸载

这是最容易让人意外的一环。在**更早某一轮**注入的块已经写进会话日志了，卸载没法追溯性地移除一条已经记录的事件。

dsh 把这件事做成了结构性约束，而不是疏漏：

- 会话日志是**只追加**的。没有删除、没有更新、没有插入——连压缩都不移除事件。
- 请求是从日志**派生**出来的（`deriveMessages()` 在 *surface* 这个有序投影上工作）。不存在「编辑即将发出的请求」这一步，请求是算出来的。
- `agent/pre-step` 交给你的是 `messages: claimed`，也就是**本轮**新 claim 的消息，不是完整历史。历史里的块从不经过它。
- `agent/request` 是模型配置瀑布，它的契约白纸黑字写着**不能改消息**。

所以，让已记录内容对模型不可见的唯一正当手段，是追加一条**遮蔽**它的新事件：

```js
session.append('user/message', content, {
  surfaceOp: { op: 'replace', start: seq, end: seq },  // start === end：单个节点
  sourceEventSeqs: [seq],                              // 每一个被遮蔽的节点
})
```

`start === end` 精确退役一个节点——不需要 LLM 摘要，不碰相邻历史。旧事件仍然留在日志里（可重放、可审计），只是不再出现在 surface 上，于是 `deriveMessages()` 不再投影它。

**开关打开时，本插件会扫描该工作区所有活跃会话，找出持有 `<hindsight_knowledge>` 块的 surface 节点，就地退役它们。** 剥掉块之后如果还剩下别的内容就保留；整条消息只有块的话，替换成一句简短标记。

和压缩的两点关键区别：

| | 本插件 | 压缩 |
| --- | --- | --- |
| 精度 | 单个节点 | 按 token 压力选的连续区间 |
| 摘要 | 无——按文本剥离 | LLM 写的摘要 |
| 模型调用 | 无 | 一次 |
| 附带影响 | 无 | 相邻历史被一起摘要 |

压缩仍然作为可选兜底保留（`compactOnDisable: true`），用于极少数 surface 遮蔽不可用的情况。

### 为什么不能直接在请求里过滤

这个想法很自然：挂 `agent/pre-step`，把块从 `decision.messages` 里剥掉，返回过滤后的数组。[dsh-mask](https://github.com/PerryLink/dsh-mask) 脱敏 PII 就是这么做的，而且有效——因为它的原文**根本不进日志**，它守的是入口。

残留块是相反的问题：它**已经被记录了**。守入口赶不走已经住进去的房客。

## Token 账本

上面两个效果都省 token，但节奏不同。

**工具定义——每一轮都省。** 工具的 schema 是每次请求装配的一部分，所以去掉八个工具，等于从本次会话**后续每一轮**里都拿掉这部分开销。这是最大、最可靠的节省，而且从开关打开的那一刻就开始。

**召回注入——不再复现 + 追溯清除，两部分都省。** 注入块**只产生一次**（Hindsight 在事件级做了去重，不会每个工具步重新注入）。但一旦被记录，它就躺在历史里，被投影进**之后每一轮**的请求。所以节省是双份的：

- *面向未来：* 不再产生新块。
- *追溯既往：* 退役已有的块，把它从本次会话后续所有请求里移除。

第二点就是 surface 清扫存在的全部理由。没有它，一个第一轮开着 HindSight 的会话，会为那个块付一辈子钱——会话跑得越久，累计越多。

两点诚实的说明：

- **KV cache 会摊薄边际成本。** 位于历史前部的块，第一次发送后前缀就被缓存了，后续轮次比朴素的「× 轮数」要便宜。节省是真的，但任何一次 cache miss（上下文改动、会话恢复）都会按全价重新计价。
- **新会话本来就是干净的。** 如果你只关心*未来*的会话，卸载本身就够了；清扫解决的是「别为你已经决定不要的历史持续付费」。

## 安装

### 1. 装包

```sh
dsh plugin --profile web add github:ckcfcc/dsh-hindsight-workspace-switch
```

或

```sh
dsh plugin --profile web add dsh-hindsight-workspace-switch
```


因为包声明了 `dsh.bundle`，`dsh plugin` 会自动把它追加进 profile 的 `dsh.profile.bundles`。这一半**不需要手改任何文件**，卸载时也会自动撤销该层。

### 2. 接管 `hindsight` 行

每个 profile 跑一次安装脚本：

```sh
node node_modules/dsh-hindsight-workspace-switch/scripts/setup.mjs --profile web
```

HindSight 自己的安装器把它的行写进了 `$DSH_HOME/cordis.patch.yml`，也就是**home 层**——这一层在所有 bundle 层**之后**应用。因此 bundle 层无法覆盖它，这就是此步骤没法合并进 `dsh plugin add` 的原因，无论包怎么声明都不行。

脚本会备份 home patch，从中移除 HindSight 的行，并把同一行（带真实 `target`）记录到**profile 层**——它位于 bundle 层之上、home 层之下：

```yaml
# DSH_HINDSIGHT_WORKSPACE_SWITCH_START
- insert:
  - id: hindsight
    name: dsh-hindsight-workspace-switch
    config:
      target: file:///C:/Users/ds/.hindsight/coding-agents/dist/dsh.js
# DSH_HINDSIGHT_WORKSPACE_SWITCH_END
```

脚本从它搬走的块里读出 `target`，所以不管 HindSight 原来声明成 `name: "file:///…"` 还是 `config.target` 都能工作。重复运行是幂等的。先加 `--dry-run` 可以看它会改什么，也可以用 `--target <url>` 手工指定路径。

如果你更愿意手动改，就自己编辑 `$DSH_HOME/cordis.patch.yml`：保留 `id: hindsight` 和原来的路径（留成注释即可——插件会扫描 patch 文本里的 `file:` URL——或者写成 `config: { target: "file:///…" }`），把 `name` 换成这个包的名字。

**这一步是必需的。** 如果原样留着原来的行，HindSight 会照常被全局挂载；本插件检测到后**不会重复挂载**，只在日志里给一条警告、界面上不显示开关——宁可什么都不做，也不让记忆被调用两次。

### 3. 重启 dsh

```sh
dsh --profile web --dump-config   # 应看到 hindsight 行的 name 指向本插件
```

`package.json` 的依赖和 bundles 列表**不在**热重载范围内，所以装完要重启。patch 的**内容**改动是热更新的。

### 卸载

```sh
node node_modules/dsh-hindsight-workspace-switch/scripts/teardown.mjs --profile web
dsh plugin --profile web remove dsh-hindsight-workspace-switch
```

**顺序不能反。** Teardown 从备份恢复 home 行，remove 只撤销 bundle 层。反过来做，`hindsight` 行就哪儿都不存在了——Hindsight 静默不再加载，这是个事后很难查的故障。

## 状态存在哪

`$DSH_HOME/hindsight-switch.json`，原子写入（临时文件 + rename）：

```json
{ "version": 1, "disabled": { "<workspace-id>": true } }
```

键是 Workspace id（会话 cwd 的 `realpath` 命中 workspace 注册表时）；目录没被登记成工作区时，用 `dir:<canonical path>` 兜底，所以这种会话也有自己的开关。

## 配置项

写在 profile patch 里该行的 `config:` 下：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `target` | — | HindSight 模块 URL。由安装脚本写入。 |
| `shadowOnDisable` | `true` | 用 surface 遮蔽退役残留块。 |
| `compactOnDisable` | `false` | 没退役任何块时退回压缩。会消耗一次模型调用。 |
| `enableTrace` | `false` | 把追踪日志写到 `traceFile`。不显式设为 `true` 就不写。 |
| `traceFile` | — | 追踪文件的绝对路径。没给路径就不追踪。 |
| `stateFile` | `$DSH_HOME/hindsight-switch.json` | 开关文档的位置。 |

插件日志不一定能到达进程 stdout，所以追踪是直接追加到磁盘的。`enableTrace` 和 `traceFile` **两个都要设**——只配一半会保持静默，而不是突然给你冒出一个文件。

## 界面

开关注册在 `conversation.input.right`——也就是 composer 工具行里、模型选择器紧邻的左侧：

- `role="switch"`，`aria-checked` 表示**是否已禁用**；
- 只在宿主返回 `installed: true` 时渲染，没装 HindSight 就完全不出现；
- 切换是乐观更新的，宿主写失败会回滚；
- 读状态走 `GET /api/hindsight-switch?sessionId=…`，写状态走 `POST`，这是 webserver 上的一条 exact 路由（exact 路由优先于 connection 的 `/api` 前缀，两者不冲突）。

## 已知边界

- **信任围栏只认 loopback**：路由复用了 connection 对 `/api` 的两道防线（Host 头防 DNS rebinding、`sec-fetch-site`/Origin 防跨站），但可信 Host 列表只含 loopback，也就是 Web 的默认绑定。要在 LAN 上暴露，请自己扩展 `src/route.js` 里的 `isTrusted`，或走反向代理。
- **会话没有 cwd 时不挂载**：老会话（持久化头里没有 cwd）不做决策，不开也不关。
- **遮蔽需要活跃 agent**：清扫遍历的是 `ctx.agents.list()`，所以它只处理当前打开的会话。已经关闭、之后才恢复的会话，其块会一直留着，直到有东西遮蔽它。
- **压缩是钝器**：它之所以是可选的就是这个原因——它按 token 压力选区间做摘要，会重写相邻历史，还要一次模型调用。优先用默认的遮蔽。
- **HindSight 自身的配置不受影响**：服务端地址、bank 命名这些仍然在 `~/.hindsight/coding-agent.json` 里；本插件原样透传 HindSight 插件的配置。
- **客户端 bundle 是手写的**：仓库内的 `tsdown` 客户端预设没有对外发布，所以 `client/index.cjs` 自己调用 `window.__ModuleLoader__.load` 并只从模块表取 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`，样式是一段带前缀的注入 CSS（没有 CSS Modules 构建步骤）。
- **开关文案**在 `client/index.cjs` 里的 `zh` / `en` 字典，直接改即可。

## 自检

1. 没装 HindSight：把 `hindsight` 行整段删掉重启 → 输入区不出现开关，`--dump-config` 里没有 hindsight 行。
2. 装好并按上面接管后：随便开一个会话 → 模型选择器左边出现 `HindSight` 开关，默认关闭（未禁用）。让模型列出它可用的工具，确认 `hindsight_*` 在里面。
3. 打开开关 → 工具定义分组立刻下降，该工作区正在跑的会话也停止写回。
4. **清扫之后，在同一个会话里**问模型：上下文里有没有以 `<hindsight_knowledge>` 开头的内容？它应该回答没有。在本插件退役块之前，它能一字不差地把块复述出来。
5. 切到另一个工作区的会话 → 开关仍是关闭状态，记忆照常。清扫是按工作区限定范围的，一个工作区的开关不会打扰另一个工作区的历史。
6. 关掉开关 → 该工作区恢复，正在跑的会话立即重新挂载。
