/**
 * Browser half — the composer switch, at `conversation.input.right`, the seat
 * rendered immediately left of the model selector.
 *
 * This file is a hand-written stand-in for the loader's client bundle: the
 * module system fetches `exports["./client"]` and materializes it as CommonJS,
 * so the file calls `window.__ModuleLoader__.load` with its own factory and
 * takes React and the shared UI primitives from the injected module table. It
 * imports no other plugin's runtime values — cross-plugin collaboration goes
 * through the slot registry and the host route.
 */

window.__ModuleLoader__.load({
  id: 'dsh-hindsight-workspace-switch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    var React = require('react')
    var Tooltip = require('@deepseek-ai/dsh-client-ui-primitives').Tooltip

    /** Dictionary namespace owned by this plugin. */
    var NS = 'hindsight-switch'
    /** Route served by the host half. */
    var ROUTE = '/api/hindsight-switch'
    /** Class-name prefix: this bundle has no CSS Modules build step. */
    var PREFIX = 'dsh-hsw-'

    var zh = {
      'label': 'HindSight',
      'aria': '禁用 HindSight（按工作区）',
      'tooltip.on': '已禁用 HindSight：本工作区不召回记忆、不写回会话、不加载 hindsight_* 工具',
      'tooltip.off': 'HindSight 已启用。开启后本工作区立即停用：不召回、不写回、不注册工具',
      'tooltip.error': '开关状态读取失败，点击重试',
    }
    var en = {
      'label': 'HindSight',
      'aria': 'Disable HindSight (per workspace)',
      'tooltip.on': 'HindSight is off for this workspace: no recall, no write-back, no hindsight_* tools',
      'tooltip.off': 'HindSight is on. Switching disables it for this workspace at once',
      'tooltip.error': 'Could not read the switch state — click to retry',
    }

    var CSS = [
      '.' + PREFIX + 'button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px;',
      'border:0;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font-family:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;}',
      '.' + PREFIX + 'button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.' + PREFIX + 'button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.' + PREFIX + 'button:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;}',
      '.' + PREFIX + 'label{white-space:nowrap;}',
      '.' + PREFIX + 'track{position:relative;box-sizing:border-box;flex:0 0 auto;width:28px;height:16px;',
      'padding:2px;border-radius:8px;background:var(--dsw-alias-border-l3);}',
      '.' + PREFIX + 'on .' + PREFIX + 'track{background:var(--dsw-alias-state-warn-primary);}',
      '.' + PREFIX + 'thumb{display:block;width:12px;height:12px;border-radius:50%;corner-shape:round;',
      'background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease;}',
      '.' + PREFIX + 'on .' + PREFIX + 'thumb{transform:translateX(12px);}',
      '@media (prefers-reduced-motion: reduce){.' + PREFIX + 'thumb{transition:none;}}',
    ].join('')

    /**
     * Install this plugin's stylesheet once per document.
     * The loader's own bundles inject hashed CSS Modules at build time; a
     * hand-written bundle ships one prefixed sheet instead.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + NS + '"]') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = NS
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * The shared switch store. One source serves every composer: selecting by
     * workspace id is what keeps two sessions of the same workspace showing —
     * and flipping — the same position.
     * @returns the bare observable source.
     */
    function createStore() {
      var snapshot = { installed: false, session: {}, workspace: {} }
      var listeners = new Set()
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        update: function (mutate) {
          // Unchanged entries keep their identity, so a selector returning one
          // stays referentially stable across unrelated publishes.
          var draft = {
            installed: snapshot.installed,
            session: Object.assign({}, snapshot.session),
            workspace: Object.assign({}, snapshot.workspace),
          }
          mutate(draft)
          snapshot = draft
          listeners.forEach(function (listener) { listener() })
        },
      }
    }

    /** Read one session's view, or throw carrying the HTTP status. */
    function call(sessionId, body) {
      var init = body === undefined
        ? { method: 'GET' }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      return fetch(ROUTE + '?sessionId=' + encodeURIComponent(sessionId), init).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + String(response.status))
        return response.json()
      })
    }

    /**
     * One store for the whole page: two composers of the same workspace select
     * the same entry, and a remount (the composer's slot collapsing) keeps the
     * state already fetched.
     */
    var store = createStore()
    /** Sessions already fetched, so a failed read can be retried by re-render. */
    var requested = new Set()

    /**
     * Read one session's workspace position from the host.
     * @param sessionId - session the composer is bound to.
     * @returns settlement after the store publish.
     */
    function load(sessionId) {
      requested.add(sessionId)
      return call(sessionId).then(function (view) {
        store.update(function (draft) {
          draft.installed = view.installed === true
          if (typeof view.workspaceId !== 'string' || view.workspaceId === '') return
          draft.session[sessionId] = view.workspaceId
          draft.workspace[view.workspaceId] = {
            disabled: view.disabled === true,
            title: typeof view.workspaceTitle === 'string' ? view.workspaceTitle : '',
            pending: false,
            error: null,
          }
        })
      }, function (error) {
        requested.delete(sessionId)
        store.update(function (draft) {
          draft.workspace[draft.session[sessionId]] = {
            disabled: false, title: '', pending: false, error: String(error && error.message || error),
          }
        })
      })
    }

    /**
     * Flip one session's workspace. The optimistic publish keeps the switch
     * responsive; the host is the authority, so a failed write restores it.
     * @param sessionId - session the composer is bound to.
     */
    function toggle(sessionId) {
      var workspaceId = store.getSnapshot().session[sessionId]
      var entry = store.getSnapshot().workspace[workspaceId]
      if (entry === undefined || entry.pending) return
      var next = !entry.disabled
      store.update(function (draft) {
        draft.workspace[workspaceId] = Object.assign({}, entry, { disabled: next, pending: true, error: null })
      })
      call(sessionId, { sessionId: sessionId, disabled: next }).then(function (view) {
        store.update(function (draft) {
          draft.workspace[workspaceId] = {
            disabled: view.disabled === true,
            title: typeof view.workspaceTitle === 'string' ? view.workspaceTitle : entry.title,
            pending: false,
            error: null,
          }
        })
      }, function (error) {
        store.update(function (draft) {
          draft.workspace[workspaceId] = Object.assign({}, entry, {
            pending: false, error: String(error && error.message || error),
          })
        })
      })
    }

    exports.name = 'hindsight-switch'
    exports.inject = ['slots', 'locale']

    /**
     * Register the dictionaries and the composer switch.
     * @param ctx - browser plugin context.
     */
    exports.apply = function (ctx) {
      ensureStyles()
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }) }, NS + ': dictionaries')

      ctx.slots.inject('conversation.input.right', function () {
        return ctx.slots.register({
          name: 'conversation.input.right',
          id: 'hindsight-switch',
          order: 100,
          locale: NS,
          inject: function (sessionId) {
            return {
              toggle: function () { toggle(sessionId) },
              hooks: { status: store },
            }
          },
        }, HindsightSwitch)
      })
    }

    /**
     * The switch. Renders nothing while HindSight is not installed, while the
     * session's workspace is unknown, or before the first host answer.
     * @param props - slot-derived props plus this entry's injected face.
     * @returns the control, or null.
     */
    function HindsightSwitch(props) {
      var useStatus = props.useStatus
      var sessionId = props.sessionId
      var installed = useStatus(function (state) { return state.installed })
      var workspaceId = useStatus(function (state) {
        return state.session[sessionId] === undefined ? null : state.session[sessionId]
      })
      var entry = useStatus(function (state) {
        return workspaceId === null ? null : (state.workspace[workspaceId] === undefined ? null : state.workspace[workspaceId])
      })
      var removed = props.useSession(function (session) { return session.removed === true })
      var missing = workspaceId === null && !requested.has(sessionId)
      React.useEffect(function () {
        if (missing) void load(sessionId)
      }, [sessionId, missing])
      if (!installed || workspaceId === null || entry === null) return null

      var pending = entry.pending === true
      var label = entry.error !== null
        ? props.t('tooltip.error')
        : (entry.disabled ? props.t('tooltip.on') : props.t('tooltip.off'))
      return React.createElement(Tooltip, { label: label, side: 'top', delayMs: 500 },
        React.createElement('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': entry.disabled,
          'aria-label': props.t('aria'),
          className: PREFIX + 'button' + (entry.disabled ? ' ' + PREFIX + 'on' : ''),
          disabled: pending || removed,
          onClick: props.toggle,
        },
        React.createElement('span', { className: PREFIX + 'label' }, props.t('label')),
        React.createElement('span', { className: PREFIX + 'track', 'aria-hidden': true },
          React.createElement('span', { className: PREFIX + 'thumb' }))))
    }

    return module.exports
  },
})
