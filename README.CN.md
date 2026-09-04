# dsh-hindsight-workspace-switch

给 DeepSeek Harness（dsh）的会话输入区加一个**按工作区**的 HindSight 开关：在模型选择器的左边显示一个 switch，打开即为「禁用 HindSight」。没装 HindSight 时不显示这个开关。

## 它怎么做到真正的关闭

HindSight 的 `dist/dsh.js` 是一个普通 Cordis 插件，它做四件事，四件都是**注册**：

| 它注册的 | 作用 |
|---|---|
| `agent/session-start` 监听 | 首次开会话时播种记忆库 |
| `agent/pre-step` 监听 | 召回记忆并注入上下文 |
| `agent/turn-stopping` 监听 | 会话结束时把整段对话写回 bank |
| `ctx.tools` 上的 `hindsight_*` 工具 | 显式存取知识 |

Cordis 的注册是**可逆的效果**，而且 dsh 的分派是按 scope 过滤的：把插件挂到某个 agent 的作用域上下文 `agent.ctx` 上，这四件事就只属于这个 agent；销毁这个挂载，四件事一起消失。所以本插件不是去「拦」HindSight，而是**接管挂载权**：

- 本插件占据 `hindsight` 这一行，自己 `import` 原来的 `dist/dsh.js`；
- 每个 agent 创建时，按它所属工作区查开关状态，只在**未禁用**的工作区把 HindSight 挂到 `agent.ctx` 上；
- 切换开关时，该工作区正在跑的会话**立即**卸载/挂载，不需要等下一次开会话。

「禁用」的完整含义：不召回、不写回、不注册 `hindsight_*` 工具。

## 安装

### 1. 装包

```sh
dsh plugin --profile <profile> add dsh-hindsight-workspace-switch
```

`dsh plugin` 会在 profile 目录里装好依赖，让 Cordis 能按包名解析到这个插件。

### 2. 接管 `hindsight` 行

编辑 `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/cordis.patch.yml`），把 HindSight 那段**改成**：

```yaml
# HINDSIGHT_CODING_AGENTS_DSH_START
- insert:
    - id: hindsight
      # original: file:///C:/Users/ds/.hindsight/coding-agents/dist/dsh.js
      name: "dsh-hindsight-workspace-switch"
# HINDSIGHT_CODING_AGENTS_DSH_END
```

也就是：**保留 `id: hindsight` 和原来的路径（留成注释即可），把 `name` 换成这个包的名字。** 注释里那行 `file:` URL 就是本插件找到 HindSight 入口的地方；不想靠注释也可以写成 `config: { target: "file:///..." }`，两种都支持。

这一步是必需的。如果原样留着原来的 `hindsight` 行，HindSight 会照常被全局挂载，本插件检测到后**不会重复挂载**，并且在日志里给出一条警告、界面上不显示开关——宁可什么都不做，也不让记忆被调用两次。

### 3. 重启 dsh

```sh
dsh --profile <profile> --dump-config   # 应看到 hindsight 行的 name 指向本插件
```

## 状态存在哪

`$DSH_HOME/hindsight-switch.json`，原子写入（临时文件 + rename）：

```json
{ "version": 1, "disabled": { "<workspace-id>": true } }
```

键是 Workspace id（会话 cwd 的 `realpath` 命中 workspace 注册表时）；目录没被登记成工作区时，用 `dir:<canonical path>` 兜底，所以这种会话也有自己的开关。

## 界面

开关注册在 `conversation.input.right`——也就是 composer 工具行里、模型选择器紧邻的左侧：

- `role="switch"`，`aria-checked` 表示**是否已禁用**；
- 只在宿主返回 `installed: true` 时渲染，没装 HindSight 就完全不出现；
- 切换是乐观更新的，宿主写失败会回滚；
- 读状态走 `GET /api/hindsight-switch?sessionId=…`，写状态走 `POST`，这是 webserver 上的一条 exact 路由（exact 路由优先于 connection 的 `/api` 前缀，两者不冲突）。

## 已知边界

- **信任围栏只认 loopback**：路由复用了 connection 对 `/api` 的两道防线（Host 头防 DNS rebinding、`sec-fetch-site`/Origin 防跨站），但可信 Host 列表只含 loopback，也就是 Web 的默认绑定。要在 LAN 上暴露，请自己扩展 `src/route.js` 里的 `isTrusted`，或走反向代理。
- **会话没有 cwd 时不挂载**：老会话（持久化头里没有 cwd）不做决策，不开也不关。
- **HindSight 自身的配置不受影响**：服务端地址、bank 命名这些仍然在 `~/.hindsight/coding-agent.json` 里；本插件原样透传 HindSight 插件的配置。
- **客户端 bundle 是手写的**：仓库内的 `tsdown` 客户端预设没有对外发布，所以 `client/index.cjs` 自己调用 `window.__ModuleLoader__.load` 并只从模块表取 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`，样式是一段带前缀的注入 CSS（没有 CSS Modules 构建步骤）。
- **开关文案**在 `client/index.cjs` 里的 `zh` / `en` 字典，直接改即可。

## 自检

1. 没装 HindSight：把 `hindsight` 行整段删掉重启 → 输入区不出现开关，`--dump-config` 里没有 hindsight 行。
2. 装好并按上面接管后：随便开一个会话 → 模型选择器左边出现 `HindSight` 开关，默认关闭（未禁用），`hindsight_*` 工具可用。
3. 打开开关 → 该工作区正在跑的会话立刻失去 `hindsight_*` 工具，也不会再写回；同一工作区新开的会话同样没有。
4. 切到另一个工作区的会话 → 开关仍是关闭状态，记忆照常。
5. 关掉开关 → 该工作区恢复，正在跑的会话立即重新挂载。
