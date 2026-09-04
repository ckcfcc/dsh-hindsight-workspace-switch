/**
 * 在 agent/pre-step 阶段剥离 <hindsight_knowledge> 块。
 *
 * 签名（packages/core/agent/src/runtime-types.ts:238）：
 *   'agent/pre-step'(
 *     payload: { agent, messages, turn, step, signal },
 *     next: () => Promise<PreStepDecision>   // 不接受参数
 *   ): Promise<PreStepDecision>
 *
 * PreStepDecision = { kind: 'reject' } | { kind: 'enter', messages }
 */

const BLOCK_RE = /<hindsight_knowledge(?:\s[^>]*)?>[\s\S]*?<\/hindsight_knowledge>/gi
const UNCLOSED_RE = /<hindsight_knowledge(?:\s[^>]*)?>[\s\S]*$/i

function stripText(text, opts) {
  if (typeof text !== 'string' || !text.includes('<hindsight_knowledge')) return text
  let out = text.replace(BLOCK_RE, '')
  if (opts.stripUnclosed && UNCLOSED_RE.test(out)) out = out.replace(UNCLOSED_RE, '')
  return out.trim()
}

function stripContent(content, opts) {
  if (typeof content === 'string') return stripText(content, opts)
  if (Array.isArray(content)) {
    let changed = false
    const parts = []
    for (const part of content) {
      if (part && part.type === 'text' && typeof part.text === 'string') {
        const stripped = stripText(part.text, opts)
        if (stripped !== part.text) changed = true
        if (stripped) parts.push({ ...part, text: stripped })
      } else {
        parts.push(part)
      }
    }
    return changed ? parts : content
  }
  return content
}

function stripMessage(msg, opts) {
  if (!msg || typeof msg !== 'object') return msg
  const before = msg.content ?? msg.text
  const after = stripContent(before, opts)
  if (after === before) return msg
  const emptied =
    (typeof after === 'string' && after.trim() === '') ||
    (Array.isArray(after) && after.length === 0)
  if (emptied) return null
  if (msg.content !== undefined) return { ...msg, content: after }
  if (msg.text !== undefined) return { ...msg, text: after }
  return msg
}

export function filterMessages(messages, opts = {}) {
  if (!Array.isArray(messages)) return messages
  let removed = 0
  let strippedChars = 0
  const out = []
  for (const msg of messages) {
    const raw = msg?.content ?? msg?.text
    const before = typeof raw === 'string' ? raw.length : 0
    const next = stripMessage(msg, opts)
    if (next === null) {
      removed += 1
      strippedChars += before
      continue
    }
    if (next !== msg) {
      const afterRaw = next.content ?? next.text
      strippedChars += Math.max(0, before - (typeof afterRaw === 'string' ? afterRaw.length : 0))
    }
    out.push(next)
  }
  if (removed || strippedChars) opts.onStrip?.({ removed, strippedChars })
  return out
}

/**
 * 在给定 context 上挂载过滤器。
 *
 * @param ctx - 必须是 agent 作用域的 context（agent.ctx），root 收不到
 *   agent 作用域事件。
 * @param gate (payload) => boolean —— 返回 true 才剥离。
 * @param opts - { stripUnclosed, onStrip, trace }。
 * @returns dispose 函数。
 */
export function installStripFilter(ctx, gate, opts = {}) {
  const trace = opts.trace ?? (() => {})
  return ctx.on('agent/pre-step', async (payload, next) => {
    trace('pre-step fired, kind=' + (payload === null || typeof payload !== 'object' ? typeof payload : 'object'))
    const should = typeof gate === 'function' ? gate(payload) : true
    trace('gate=' + should)
    if (should !== true) return next()

    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
      trace('decision bypassed: ' + JSON.stringify(decision?.kind))
      return decision
    }
    const messages = filterMessages(decision.messages, opts)
    trace('messages ' + decision.messages.length + ' -> ' + messages.length)
    return messages === decision.messages ? decision : { ...decision, messages }
  })
}