/**
 * Host half — a per-workspace on/off switch for the HindSight plugin.
 *
 * HindSight's `dist/dsh.js` is an ordinary Cordis plugin that seeds a bank on
 * `agent/session-start`, injects recall on `agent/pre-step`, writes the
 * conversation back on `agent/turn-stopping`, and registers its `hindsight_*`
 * tools. All four are registrations, so mounting that plugin on one agent's
 * scoped context (`agent.ctx`) confines all four to that agent, and disposing
 * the mount removes them: no recall, no write-back, no tools.
 *
 * This plugin owns the `hindsight` row, decides per workspace whether to mount,
 * keeps the decision in one JSON document, and serves the composer switch.
 *
 * Unmounting stops NEW recall. A block injected during an earlier turn is
 * already in the session log, and the request is projected from that log, so no
 * hook rewrites it. SurfaceOp.replace is the sanctioned seam: with
 * start === end it shadows exactly one surface node, so a residual block is
 * retired without an LLM summary and without touching neighbouring history.
 *
 * Config:
 *   target           HindSight module URL (required).
 *   stateFile        where the per-workspace switch document lives.
 *   patchFiles       extra patch files to scan for the target.
 *   shadowOnDisable  retire residual blocks via surface shadowing (default true).
 *   compactOnDisable fall back to compaction when nothing was retired (default false).
 *   enableTrace      write trace lines to traceFile (default false).
 *   traceFile        absolute path of the trace sink; no file means no tracing.
 */

import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'
import {
  PACKAGE, findTargetInText, isForeignHindsight, patchFilePaths, scanPatchRows,
} from './patch.js'
import { WorkspaceSwitchState } from './state.js'
import { createSwitchRoute } from './route.js'

export const name = 'hindsight-workspace-switch'

/** Agent registry for live mounts, and the session store for cold sessions. */
export const inject = ['agents', 'sessions']

/**
 * Marker left in place of a shadowed block. Short on purpose: it stands in for
 * a multi-kilobyte recall block, and it names itself so a reader of the derived
 * history understands why the span is missing.
 */
const REMOVED_MARKER = '[HindSight recall removed — the workspace switch is off]'

/** Tag identifying an injected recall block. */
const BLOCK_OPEN = '<hindsight_knowledge'

/** Strips one or more complete recall blocks out of a text. */
const BLOCK_RE = /<hindsight_knowledge(?:\s[^>]*)?>[\s\S]*?<\/hindsight_knowledge>/gi

/**
 * @param ctx - host plugin context.
 * @param config - row config, see the file header.
 */
export async function apply(ctx, config = {}) {
  // --- trace sink -------------------------------------------------------
  // Plugin logs do not reliably reach process stdout, so tracing appends
  // straight to disk. Off unless both switches say so.
  const traceFile = firstString(config.traceFile, process.env.HINDSIGHT_SWITCH_TRACE)
  const enableTrace = config.enableTrace === true && traceFile !== undefined

  const logger = createLogger(ctx, traceFile, enableTrace)
  const trace = (message) => { if (enableTrace) logger.info(message) }
  if (enableTrace) trace(`hindsight-switch: trace sink on -> ${traceFile}`)

  const state = new WorkspaceSwitchState(firstString(config.stateFile, process.env.HINDSIGHT_SWITCH_STATE))
  const extraFiles = Array.isArray(config.patchFiles) ? config.patchFiles.filter(item => typeof item === 'string') : []

  const rows = scanPatchRows(extraFiles)
  const foreign = rows.find(isForeignHindsight)
  const target = firstString(config.target, process.env.HINDSIGHT_DSH_TARGET)
  // const target = firstString(config.target, process.env.HINDSIGHT_DSH_TARGET)
  //   ?? patchFilePaths(extraFiles)
  //     .map(file => readTarget(file))
  //     .find(candidate => candidate !== undefined)
  //   ?? foreign?.name

  let plugin
  if (foreign !== undefined) {
    logger.warn(`the "${foreign.id ?? '?'}" row still mounts HindSight directly (${foreign.name}) — `
      + `point that row's name at ${PACKAGE} and keep the original path as config.target, `
      + 'otherwise HindSight stays mounted for every workspace and this switch does nothing.')
  } else if (target === undefined) {
    logger.info('no HindSight entry found in any cordis.patch.yml layer — nothing to switch.')
  } else {
    plugin = await loadPlugin(target, logger)
    if (plugin === undefined) logger.warn(`HindSight entry ${target} did not export a Cordis plugin.`)
    else logger.info(`HindSight mounted per workspace from ${target}; state file ${state.file}.`)
  }

  // A bundle layer can mount this package a second time under an id derived
  // from the package name, and that row carries no `target` of its own. It has
  // nothing to switch, and it has to stay out of the way: registering
  // /api/hindsight-switch from the empty instance shadows the real one, and
  // the composer then reads installed: false and hides the switch altogether.
  if (plugin === undefined) {
    logger.info('hindsight-switch: this row has no HindSight target — standing down '
      + 'because another row already owns the switch.')
    return
  }

  /** Live mounts, keyed by session id. */
  const mounted = new Map()

  /**
   * Resolve one agent's switch key: the owning Workspace id when the registry
   * owns its canonical cwd, otherwise that cwd itself.
   * @param agent - live agent, or undefined.
   * @returns the key, its display title, or undefined without a cwd.
   */
  const resolveWorkspace = (agent) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return undefined
    let canonical = cwd
    try {
      canonical = realpathSync(cwd)
    } catch {
      // A vanished directory still keys on the path the header recorded.
    }
    const registry = service(ctx, 'workspaceRegistry')
    if (registry !== undefined) {
      try {
        const owned = registry.list().find(workspace => workspace.path === canonical)
        if (owned !== undefined) return { key: owned.id, title: owned.title, path: canonical }
      } catch {
        // Fall through to the path key: a registry read is never worth failing a session.
      }
    }
    return { key: `dir:${canonical}`, title: basename(canonical), path: canonical }
  }

  /**
   * Mount HindSight on one agent unless its workspace disabled it.
   * @param agent - live agent.
   */
  const mountIfEnabled = (agent) => {
    if (plugin === undefined || mounted.has(agent.id)) return
    const workspace = resolveWorkspace(agent)
    if (workspace === undefined || state.isDisabled(workspace.key)) return
    mounted.set(agent.id, { key: workspace.key, fork: agent.ctx.plugin(plugin, hindsightConfig(config)) })
  }

  /** Remove one agent's mount. */
  const unmount = async (sessionId) => {
    const entry = mounted.get(sessionId)
    if (entry === undefined) return
    mounted.delete(sessionId)
    await entry.fork.dispose()
  }

  if (plugin !== undefined) {
    ctx.on('agent/created', ({ agent }) => { 
      mountIfEnabled(agent)
      const workspace = resolveWorkspace(agent)
      if (workspace !== undefined && state.isDisabled(workspace.key)) {
        void retireWorkspace(workspace.key, workspace.title)
      }
    })
    ctx.on('agent/disposed', ({ agent }) => { mounted.delete(agent.id) })
    // Agents created before this plugin activated keep their own state, so a
    // patch reload does not silently strip memory from a running session.
    for (const agent of ctx.agents.list()) mountIfEnabled(agent)
    ctx.effect(async () => {
      for (const sessionId of [...mounted.keys()]) await unmount(sessionId)
    }, 'hindsight-switch: unmount every live agent')
  }

  // ---- retiring residual injected blocks -------------------------------
  //
  // SurfaceOp.replace shadows surface nodes and puts one new event in their
  // place. With start === end it retires exactly one node — no LLM summary,
  // no neighbouring history touched.

  /** Whether the unavailable-surface warning has already been emitted. */
  let surfaceWarned = false

  /**
   * Read one session event by sequence number, across the accessor shapes the
   * session class has shipped.
   * @param session - live session.
   * @param seq - event sequence number.
   * @returns the event, or undefined.
   */
  const eventAt = (session, seq) => {
    if (session === undefined || seq === undefined) return undefined
    try {
      if (typeof session.at === 'function') return session.at(seq)
    } catch { /* probe the next shape */ }
    try {
      if (typeof session.get === 'function') return session.get(seq)
    } catch { /* probe the next shape */ }
    const log = session.log ?? session.events
    if (Array.isArray(log)) return log.find(event => event?.seq === seq)
    return undefined
  }

  /**
   * Collect the text of a message's content blocks.
   * @param content - string or ContentBlock array.
   * @returns the concatenated text.
   */
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    let out = ''
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (typeof block.text === 'string') out += block.text
      else if (typeof block.content === 'string') out += block.content
    }
    return out
  }

  /**
   * Strip recall blocks out of one message's content, keeping everything else.
   * @param content - string or ContentBlock array.
   * @returns the surviving content, or undefined when nothing is left.
   */
  const stripBlocks = (content) => {
    if (typeof content === 'string') {
      const kept = content.replace(BLOCK_RE, '').trim()
      return kept === '' ? undefined : kept
    }
    if (!Array.isArray(content)) return undefined

    const kept = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') { kept.push(block); continue }
      if (typeof block.text === 'string') {
        if (!block.text.includes(BLOCK_OPEN)) { kept.push(block); continue }
        const rest = block.text.replace(BLOCK_RE, '').trim()
        if (rest !== '') kept.push({ ...block, text: rest })
        continue
      }
      kept.push(block)
    }
    return kept.length === 0 ? undefined : kept
  }

  /**
   * Retire every residual HindSight block on one agent's surface.
   *
   * Each replacement rewrites the surface, so seqs are collected up front and
   * re-checked for membership right before each append.
   *
   * The result is a small report rather than a bare count: the file sink has
   * proven unreliable and stderr is unreadable in some consoles, so the only
   * channel this plugin can trust is the HTTP response it hands back.
   *
   * @param agent - live agent.
   * @returns { scanned, blocks, retired, types, error }.
   */
  const shadowResidualBlocks = (agent) => {
    const empty = { scanned: 0, blocks: 0, retired: 0, types: {}, error: undefined }
    const session = agent?.session
    const surface = session?.surface
    if (surface === undefined || !Array.isArray(surface.nodes)) {
      if (!surfaceWarned) {
        surfaceWarned = true
        logger.warn('session surface is not readable: residual HindSight blocks stay in the '
          + 'request until a new session starts.')
      }
      return { ...empty, error: `surface unreadable (session=${session === undefined ? 'none' : 'ok'})` }
    }

    // Snapshot first: an append mutates the surface we are walking.
    const candidates = []
    const types = {}
    for (const seq of surface.nodes) {
      const event = eventAt(session, seq)
      const type = event instanceof Promise ? 'PROMISE' : (event?.type ?? 'undefined')
      types[type] = (types[type] ?? 0) + 1
      if (event?.type !== 'user/message') continue
      const data = event.data
      if (data === undefined || data === null) continue
      if (textOf(data.content).includes(BLOCK_OPEN)) candidates.push(seq)
    }
    // trace(`surface scan: ${surface.nodes.length} node(s), ${candidates.length} block(s)`)
    if (candidates.length === 0) {
      return { scanned: surface.nodes.length, blocks: 0, retired: 0, types, error: undefined }
    }

    let retired = 0
    let error
    for (const seq of candidates) {
      try {
        // An earlier replacement may have already retired this node.
        if (!session.surface.nodes.includes(seq)) continue
        const event = eventAt(session, seq)
        if (event?.type !== 'user/message' || event.data === undefined) continue

        const kept = stripBlocks(event.data.content)
        const content = kept === undefined
          ? [{ type: 'text', text: REMOVED_MARKER }]
          : kept

        // Keep source as-is: a plugin-sourced message stays plugin-sourced, so
        // HindSight's write-back does not mistake the marker for user input.
        session.append(
          'user/message',
          { ...event.data, role: 'user', content },
          {
            surfaceOp: { op: 'replace', start: seq, end: seq },
            sourceEventSeqs: [seq],
          },
        )
        retired += 1
        // trace(`retired block at seq ${seq}`)
      } catch (failure) {
        const text = messageOfError(failure)
        if (error === undefined) error = `seq ${seq}: ${text}`
        logger.warn(`could not retire the block at seq ${seq}: ${text}`)
      }
    }
    return { scanned: surface.nodes.length, blocks: candidates.length, retired, types, error }
  }

  /** The compaction engine, when the profile composes one. */
  const compaction = service(ctx, 'compaction')

  /** Whether the missing-engine warning has already been emitted. */
  let compactionWarned = false

  /**
   * Compact one agent's session — the coarse fallback when surface shadowing is
   * unavailable or disabled. Costs one model call and summarises a span.
   * @param agent - live agent.
   * @returns a short outcome tag, or undefined when the service is absent.
   */
  const requestCompact = async (agent) => {
    if (compaction === undefined) {
      if (!compactionWarned) {
        compactionWarned = true
        logger.warn('compaction service not composed: a residual HindSight block stays in the '
          + 'request until /compact runs or a new session starts.')
      }
      return undefined
    }
    const controller = new AbortController()
    try {
      const result = await compaction.compactNow(agent, controller.signal)
      return result === null || result === undefined ? 'noop' : 'done'
    } catch (error) {
      // busy / summary / changed / persistence — none of them may break the switch.
      logger.warn(`compaction for ${agent.id} did not run (${messageOfError(error)}).`)
      return 'failed'
    }
  }

  /**
   * Retire residual blocks for every live agent of one workspace. Scoped on
   * purpose: the state is per workspace, so an unscoped sweep would damage
   * sessions that still have HindSight enabled.
   *
   * @param key - workspace key.
   * @param title - workspace title, for the log line.
   * @returns { agents, scanned, blocks, retired, types, error }.
   */
  const retireWorkspace = async (key, title) => {
    const report = { agents: 0, scanned: 0, blocks: 0, retired: 0, types: {}, error: undefined }
    for (const agent of ctx.agents.list()) {
      const workspace = resolveWorkspace(agent)
      if (workspace === undefined || workspace.key !== key) continue
      report.agents += 1
      // trace(`sweeping agent ${agent.id} in ${title}`)
      if (config.shadowOnDisable !== false) {
        const one = shadowResidualBlocks(agent)
        report.scanned += one.scanned
        report.blocks += one.blocks
        report.retired += one.retired
        if (one.error !== undefined && report.error === undefined) report.error = one.error
        for (const [type, count] of Object.entries(one.types)) {
          report.types[type] = (report.types[type] ?? 0) + count
        }
      }
      if (report.retired === 0 && config.compactOnDisable === true) {
        const outcome = await requestCompact(agent)
        if (outcome !== undefined) logger.info(`hindsight-switch: compaction for ${title}: ${outcome}.`)
      }
    }
    // if (report.retired > 0) {
    //   logger.info(`hindsight-switch: retired ${report.retired} residual block(s) for ${title}.`)
    // } else {
    //   trace(`no residual block found for ${title}`)
    // }
    return report
  }

  /**
   * Apply one workspace's switch to the document and to every live agent in it.
   * @param key - workspace key.
   * @param disabled - next position.
   * @returns the sweep report, or undefined when the switch was turned on.
   */
  const setDisabled = async (key, disabled) => {
    state.setDisabled(key, disabled)
    for (const agent of ctx.agents.list()) {
      const workspace = resolveWorkspace(agent)
      if (workspace === undefined || workspace.key !== key) continue
      if (disabled) await unmount(agent.id)
      else mountIfEnabled(agent)
    }
    // Unmounting only stops future recall. Retire what earlier turns injected.
    if (disabled) return retireWorkspace(key, state.titleOf?.(key) ?? key)
    return undefined
  }

  /**
   * The view the composer switch renders: whether HindSight is installed, which
   * workspace the session belongs to, and that workspace's position.
   * @param sessionId - session the composer is bound to.
   * @returns the JSON view.
   */
  const readView = (sessionId) => {
    if (plugin === undefined) return { installed: false }
    const agent = ctx.agents.get(sessionId)
    const workspace = resolveWorkspace(agent ?? coldSession(ctx, sessionId))
    if (workspace === undefined) return { installed: true, workspaceId: undefined, disabled: false }
    return {
      installed: true,
      workspaceId: workspace.key,
      workspaceTitle: workspace.title,
      disabled: state.isDisabled(workspace.key),
      agents: ctx.agents.list().length,
    }
  }

  /**
   * Write one session workspace's position.
   *
   * The sweep report rides along in the response on purpose. Both of the other
   * observation channels have proven untrustworthy — the file sink fails
   * silently behind a catch, and stderr is mangled in some consoles — while the
   * HTTP response is something the developer can read directly in DevTools.
   *
   * @param sessionId - session whose workspace is being switched.
   * @param disabled - next position.
   * @returns the view after the write, plus the sweep report.
   */
  const writeView = async (sessionId, disabled) => {
    const workspace = resolveWorkspace(ctx.agents.get(sessionId) ?? coldSession(ctx, sessionId))
    if (workspace === undefined) throw new Error('this session has no workspace to switch')
    const sweep = await setDisabled(workspace.key, disabled)
    logger.info(`${disabled ? 'disabled' : 'enabled'} HindSight for ${workspace.title} (${workspace.key}).`)
    return {
      installed: true,
      workspaceId: workspace.key,
      workspaceTitle: workspace.title,
      disabled,
      sweep: sweep ?? null,
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register(createSwitchRoute({ readView, writeView, logger })),
      'hindsight-switch: /api/hindsight-switch route',
    )
  })
}

/**
 * Read a session that has no live agent from the session store.
 * @param ctx - host plugin context.
 * @param sessionId - session to look up.
 * @returns an object carrying a session header, or undefined.
 */
function coldSession(ctx, sessionId) {
  const store = service(ctx, 'sessions')
  if (store === undefined || sessionId === '') return undefined
  try {
    return store.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Read a Cordis service without tripping the unknown-property throw.
 * @param ctx - any context.
 * @param key - service key.
 * @returns the service, or undefined when it is not mounted.
 */
function service(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

/**
 * Import the HindSight entry and pick its Cordis plugin out of the module.
 * @param target - module URL, absolute path, or package name.
 * @param logger - plugin logger.
 * @returns the plugin definition, or undefined.
 */
async function loadPlugin(target, logger) {
  const specifier = /^[a-z]:[\\/]/i.test(target) || target.startsWith('/') || target.startsWith('./')
    ? new URL(`file://${target.replace(/\\/g, '/')}`).href
    : target
  let module
  try {
    module = await import(specifier)
  } catch (error) {
    logger.warn(`could not import the HindSight entry ${target}: ${String(error?.message ?? error)}`)
    return undefined
  }
  // A bundled plugin exports itself as `default`; a source ESM file is its own
  // plugin object. A plain function wins over either object form.
  const candidates = [module?.default, module, module?.default?.default]
  for (const candidate of candidates) {
    if (typeof candidate === 'function') return candidate
  }
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && typeof candidate.apply === 'function') return candidate
  }
  return undefined
}

/** Read the first non-empty string argument. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** Find a `file:` module URL in one patch file, comments included. */
function readTarget(file) {
  try {
    return findTargetInText(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Config handed through to the HindSight plugin, untouched by this switch.
 * @param config - this plugin's row config.
 * @returns the nested `hindsight` object, or an empty config.
 */
function hindsightConfig(config) {
  const nested = config.hindsight
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? nested : {}
}

/** Best-effort error text. */
function messageOfError(error) {
  return String(error?.message ?? error)
}

/**
 * A logger that optionally appends straight to disk, and also hands each line
 * to the dsh logger when one is mounted. Plugin logs do not reliably reach
 * process stdout, so the file sink is the only dependable tracing channel.
 *
 * @param ctx - host plugin context.
 * @param logFile - absolute path for the append-only sink.
 * @param enabled - false disables the file sink entirely.
 * @returns the logger.
 */
function createLogger(ctx, logFile, enabled) {
  let base
  try {
    base = typeof ctx.logger === 'function' ? ctx.logger('hindsight-switch') : ctx.logger
  } catch {
    base = undefined
  }

  const toFile = (level, message) => {
    if (enabled !== true || logFile === undefined) return
    const line = `${new Date().toISOString()} [${level}] ${message}`
    // stderr first: it is the one sink a catch cannot swallow.
    try {
      console.error(line)
    } catch { /* a closed stderr is not worth a session */ }
    try {
      appendFileSync(logFile, `${line}\n`)
    } catch {
      console.error(`hindsight-switch: trace write failed: ${String(error?.message ?? error)}`)
    }
  }

  const emit = (level) => (message) => {
    toFile(level, message)
    try {
      base?.[level]?.(message)
    } catch {
      // Logging must never take the session down with it.
    }
  }
  return { info: emit('info'), warn: emit('warn'), debug: emit('debug') }
}
