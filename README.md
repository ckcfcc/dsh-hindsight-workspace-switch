# dsh-hindsight-workspace-switch

[English](./README.md) | [中文](./README.CN.md)

A **per-workspace** HindSight switch for the DeepSeek Harness (dsh) composer: a
toggle sits to the left of the model selector in the session input area. Turning
it on means *HindSight disabled*. When HindSight is not installed, the toggle is
not rendered at all.

## How the switch actually turns it off

HindSight's `dist/dsh.js` is an ordinary Cordis plugin. It does four things, and
all four are **registrations**:

| What it registers | What it does |
| --- | --- |
| `agent/session-start` listener | seeds the memory bank when a session first opens |
| `agent/pre-step` listener | recalls memory and injects it into the context |
| `agent/turn-stopping` listener | writes the whole conversation back to the bank |
| `hindsight_*` tools on `ctx.tools` | explicit knowledge get/put |

Cordis registrations are **reversible effects**, and dsh dispatches through
scope filtering: mount the plugin on one agent's scoped context (`agent.ctx`)
and all four belong to that agent alone; dispose that mount and all four vanish
together. So this plugin does not *intercept* HindSight — it **takes over the
right to mount it**:

- It owns the `hindsight` row and imports the original `dist/dsh.js` itself.
- When an agent is created, it looks up that agent's workspace and mounts
  HindSight on `agent.ctx` **only** in workspaces where the switch is off.
- Flipping the switch mounts or unmounts **immediately**, in sessions already
  running in that workspace — no need to wait for the next session.

"Disabled" in full: no recall, no write-back, no `hindsight_*` tools registered.

## What flipping the switch changes

Three separate things happen, on three different timelines. Keeping them apart
explains almost every surprising observation.

### 1. Tools disappear immediately

Every `hindsight_*` tool drops out of the tool definitions at once — in sessions
that are already running, not just in new ones. In the composer's context
inspector this shows up as a negative delta on the **tool definitions** group
(`-8` on a typical HindSight install).

This is the fastest, most visible effect, and it is **permanent for the rest of
the session**: tool definitions are re-read from the registry on every assembly,
so once the mount is disposed, they never come back.

### 2. No new recall is injected

Unmounting also unbinds the `agent/pre-step` listener that performs recall, so
no **new** `<hindsight_knowledge>` block is produced from that point on. A
session started after the switch went on is completely clean.

### 3. Blocks already in the log are retired, but not by unmounting

This is the part that surprises people. A block injected during an **earlier**
turn is already in the session log, and unmounting cannot retroactively remove
something that has been recorded.

dsh makes this structural rather than accidental:

- The session log is **append-only**. There is no delete, no update, no insert.
  Even compaction never removes an event.
- The request is **derived** from that log (`deriveMessages()` over the
  *surface*, an ordered projection). There is no "edit the outgoing request"
  step — the request is computed.
- `agent/pre-step` hands over `messages: claimed`, the messages newly claimed
  **this turn**, not the full history. Historical blocks never pass through it.
- `agent/request` is the model-configuration waterfall. Its contract states
  plainly that it **cannot mutate messages**.

So the only sanctioned way to make recorded content invisible to the model is to
append a new event that **shadows** it:

```js
session.append('user/message', content, {
  surfaceOp: { op: 'replace', start: seq, end: seq },  // start === end: one node
  sourceEventSeqs: [seq],                              // every shadowed node
})
```

`start === end` retires exactly one node — no LLM summary, no neighbouring
history touched. The old event stays in the log (replayable, auditable); it just
stops appearing on the surface, so `deriveMessages()` no longer projects it.

**When the switch goes on, this plugin sweeps the workspace's live sessions,
finds surface nodes holding a `<hindsight_knowledge>` block, and retires them
in place.** Anything left over after stripping the block is kept; a node that
was nothing but the block is replaced by a short marker.

Two differences from compaction worth knowing:

| | This plugin | Compaction |
| --- | --- | --- |
| Precision | one node | a contiguous span chosen by token pressure |
| Summary | none — content is stripped textually | an LLM-written summary |
| Model call | none | one |
| Collateral | none | neighbouring history is summarised too |

Compaction remains available as an opt-in fallback (`compactOnDisable: true`)
for the rare case where surface shadowing is not usable.

### Why not just filter the request

It is a reasonable instinct: hook `agent/pre-step`, strip the block from
`decision.messages`, return the filtered array. That is exactly what
[dsh-mask](https://github.com/PerryLink/dsh-mask) does for PII, and it works —
because dsh-mask's plaintext **never enters the log**. It guards the entrance.

A residual block is the opposite problem: it is **already recorded**. Filtering
the entrance cannot evict a tenant.

## Token accounting

Both effects above reduce tokens, but on different schedules.

**Tool definitions — saved on every request.** Tool schemas are part of every
request assembly, so dropping eight of them removes that cost from *every*
subsequent turn in the session. This is the largest and most reliable saving,
and it starts the moment the switch goes on.

**Recall injection — saved once it stops recurring.** The injected block is
produced **once** (Hindsight de-duplicates at the event level; it does not
re-inject on every tool step). But once recorded, it sits in the history and is
projected into **every** later request. So the saving is twofold:

- *Going forward:* no new block is produced.
- *Retroactively:* retiring the existing block removes it from all later
  requests in that session.

That second half is the whole reason the surface sweep exists. Without it, a
session that had HindSight on for its first turn would keep paying for that
block for the rest of its life — and the longer the session runs, the more that
adds up.

Two honest caveats:

- **KV cache softens the marginal cost.** A block sitting early in the history
  gets its prefix cached after the first send, so later turns are cheaper than
  a naive "× turns" calculation suggests. The saving is still real — and any
  cache miss (context edit, session resume) re-prices it at full cost.
- **New sessions were already clean.** If you only care about *future*
  sessions, unmounting alone is enough; the sweep is about not paying for
  history you have already decided you do not want.

## Install

### 1. Install the package

```sh
dsh plugin --profile web add github:ckcfcc/dsh-hindsight-workspace-switch
```

or

```sh
dsh plugin --profile web add dsh-hindsight-workspace-switch
```


Because the package declares `dsh.bundle`, `dsh plugin` appends it to the
profile's `dsh.profile.bundles` automatically. No file editing is needed for
this half, and removing the package withdraws the layer just as automatically.

### 2. Take over the `hindsight` row

Run the setup script once per profile:

```sh
node node_modules/dsh-hindsight-workspace-switch/scripts/setup.mjs --profile web
```

HindSight's own installer writes its row into `$DSH_HOME/cordis.patch.yml`, the
**home layer**, which is applied *after* every bundle layer. A bundle therefore
cannot override it — which is why this step cannot be folded into
`dsh plugin add` no matter how the package is declared.

The script backs up the home patch, removes HindSight's row from it, and records
the same row (with the real `target`) in the **profile layer**, which sits above
the bundle layer and below the home layer:

```yaml
# DSH_HINDSIGHT_WORKSPACE_SWITCH_START
- insert:
  - id: hindsight
    name: dsh-hindsight-workspace-switch
    config:
      target: file:///C:/Users/ds/.hindsight/coding-agents/dist/dsh.js
# DSH_HINDSIGHT_WORKSPACE_SWITCH_END
```

The script reads the `target` out of the block it moves, so it works whether
HindSight was declared as `name: "file:///…"` or as `config.target`. Re-running
it is a no-op. Use `--dry-run` first to see what it would change, or `--target
<url>` to supply the path by hand.

If you prefer to do it manually, edit `$DSH_HOME/cordis.patch.yml` yourself:
keep `id: hindsight` and the original path (a comment suffices — the plugin
scans patch text for `file:` URLs — or write `config: { target: "file:///…" }`),
and swap `name` for this package's name.

**This step matters.** Leave the original row in place and HindSight keeps being
mounted globally; this plugin detects that, refuses to mount a second time, logs
a warning, and hides the switch. It would rather do nothing than let memory be
consulted twice.

### 3. Restart dsh

```sh
dsh --profile web --dump-config   # the hindsight row's name should point at this plugin
```

The `package.json` dependency and bundles list are **not** hot-reloaded, so
restart after installing. Patch *content* changes are.

### Uninstall

```sh
node node_modules/dsh-hindsight-workspace-switch/scripts/teardown.mjs --profile web
dsh plugin --profile web remove dsh-hindsight-workspace-switch
```

**Order matters.** Teardown restores the home row from its backup; removing the
package only withdraws the bundle layer. Reverse the order and the `hindsight`
row exists nowhere — HindSight silently stops loading, which is a confusing
failure to diagnose later.

## Where state lives

`$DSH_HOME/hindsight-switch.json`, written atomically (temp file + rename):

```json
{ "version": 1, "disabled": { "<workspace-id>": true } }
```

Keys are Workspace ids (used when the session cwd's `realpath` matches an entry
in the workspace registry). When the directory is not registered as a workspace,
the key falls back to `dir:<canonical path>`, so those sessions get their own
switch too.

## Configuration

Set these under the row's `config:` in the profile patch:

| Key | Default | Meaning |
| --- | --- | --- |
| `target` | — | HindSight module URL. Written by the setup script. |
| `shadowOnDisable` | `true` | Retire residual blocks via surface shadowing. |
| `compactOnDisable` | `false` | Fall back to compaction when nothing was retired. Costs a model call. |
| `enableTrace` | `false` | Write trace lines to `traceFile`. Off unless explicitly `true`. |
| `traceFile` | — | Absolute path of the trace sink. No path means no tracing. |
| `stateFile` | `$DSH_HOME/hindsight-switch.json` | Where the switch document lives. |

Plugin logs do not reliably reach process stdout, so tracing appends straight to
disk. Both `enableTrace` **and** `traceFile` must be set — a half-configured
sink stays silent rather than surprising you with a file.

## The UI

The switch registers into `conversation.input.right` — the composer tool row,
immediately left of the model selector:

- `role="switch"`, with `aria-checked` meaning **currently disabled**.
- Rendered only when the host answers `installed: true`; with HindSight absent
  it never appears.
- Toggling is optimistic; a failed host write rolls back.
- State reads go through `GET /api/hindsight-switch?sessionId=…` and writes
  through `POST`. It is an `exact` route on the webserver (exact routes take
  precedence over connection's `/api` prefix, so the two do not conflict).

## Known limits

- **The trust fence accepts loopback only.** The route reuses connection's two
  `/api` defences (Host header check against DNS rebinding, `sec-fetch-site` /
  Origin against cross-site), but the trusted Host list contains loopback only —
  which is what Web binds to by default. To expose it on a LAN, extend
  `isTrusted` in `src/route.js` yourself, or put a reverse proxy in front.
- **No cwd means no mount.** Older sessions (whose persisted header carries no
  cwd) get no decision: neither enabled nor disabled.
- **Shadowing needs a live agent.** The sweep walks `ctx.agents.list()`, so it
  retires blocks in sessions that are currently open. A session that is closed
  and later resumed still carries its block until something shadows it.
- **Compaction is a blunt instrument.** It is opt-in for a reason: it
  summarises a span chosen by token pressure, so it rewrites neighbouring
  history and costs a model call. Prefer the default shadowing.
- **HindSight's own configuration is untouched.** Server address, bank naming
  and friends stay in `~/.hindsight/coding-agent.json`; this plugin passes the
  HindSight plugin's config through unchanged.
- **The client bundle is hand-written.** The in-repo `tsdown` client preset is
  not published, so `client/index.cjs` calls `window.__ModuleLoader__.load`
  itself and pulls only `react` and
  `@deepseek-ai/dsh-client-ui-primitives` from the module table. Styling is a
  prefixed block of injected CSS (no CSS Modules build step).
- **Switch copy** lives in the `zh` / `en` dictionaries inside
  `client/index.cjs`; edit them directly.

## Self-checks

1. **HindSight absent:** delete the whole `hindsight` row and restart → no
   switch in the input area, no hindsight row in `--dump-config`.
2. **Installed and taken over:** open any session → the `HindSight` switch
   appears to the left of the model selector, off by default (not disabled), and
   the `hindsight_*` tools are available. Ask the model to list its tools and
   confirm they are there.
3. **Turn the switch on** → the tool-definition group drops immediately and
   sessions already running in that workspace stop writing back.
4. **Same session, after the sweep:** ask the model whether its context contains
   anything starting with `<hindsight_knowledge>`. It should say no. Before
   this plugin retired blocks, it could quote the block verbatim.
5. **Switch to a session in another workspace** → the switch is still off, and
   memory works normally there. The sweep is scoped per workspace, so one
   workspace's switch never disturbs another's history.
6. **Turn the switch off** → that workspace recovers, and running sessions
   re-mount immediately.

## Changelog

### 2026-09-08
- **Bug Fix**: Resolved an issue where HindSight injection blocks were not correctly stripped in the first turn of a new session.
  - Enhanced `stripBlocks` to support the `content` field in content blocks (handling Markdown injections).
  - Expanded `shadowResidualBlocks` to scan all surface event types (including `assistant/message` and `tool/result`), ensuring robust removal of residual blocks across the entire session history.
  - Added internal `eventContent` helper for consistent message extraction.
