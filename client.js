/**
 * pluginlet — browser half.
 *
 * One Conversation View tab per `*.pluginlet` file in the session's workspace, so
 * the tabs read 对话 / 轨迹 / notes / atlas. The repository decides which pluginlets
 * exist; each one loads lazily the first time its tab is opened.
 *
 * Settings are not here: development mode, the discovery patterns, the
 * capability switches and the network budget all come from the plugin `Config`
 * (the harness's own plugin configuration), and the Host enforces them.
 *
 * The sandbox is the security boundary, not the scanner:
 *   - the iframe carries `sandbox="allow-scripts"` (no same-origin), so it has an
 *     opaque origin and cannot touch this page's DOM, storage, or cookies;
 *   - its document ships a CSP of `default-src 'none'`, so it has no network at
 *     all: the only way out is `postMessage` to this host, which forwards
 *     explicit capability calls to the Host routes;
 *   - `fs` and `net` therefore exist only as wrapped calls, budgeted on both
 *     sides and audited;
 *   - `api.write.request` never writes: it raises a confirmation dialog here,
 *     and only a click there sends `confirmed: true` to the Host.
 *
 * Editor sources are plain JavaScript (no JSX, no imports): the package ships
 * without a build step, so no compiler is in the loop.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pluginlet',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'pluginlet'
    const API = '/api/pluginlet'
    const HEADERS = {
      'content-type': 'application/json',
      'x-dsh-plugin': 'pluginlet',
    }
    /** Per-tab capability budget on the host side of the bridge. */
    const CALL_WINDOW_MS = 60_000
    const CALL_WINDOW_MAX = 120

    const ZH = {
      'view.label': 'Pluginlet',
      'blockedTitle': '静态扫描拒绝了这份源码',
      'blockedBody': '源码里有沙箱不允许的构造——动态执行、自带网络、绕过受管能力之类。这些构造无法授权，只能改掉再扫描。',
      'blockedLine': '第 {line} 行',
      'grantTitle': '这个 pluginlet 需要授权',
      'grantBody': '静态扫描没发现被禁的构造，但源码要动下面的能力。授权只对这一份内容有效：改一个字就作废，需要重新批准。',
      'grantCaps': '申请的能力与路径',
      'grantAllow': '允许',
      'grantHint': '能力开关和开发模式在「插件 → Pluginlet」里；这里只批准当前这一份内容。',
      'stale': '内容变了，需要重新授权。',
      'unavailable': '被插件配置关掉的能力：',
      'rescan': '重新扫描工作区',
      'error': '出错了',
      'retry': '重试',
      'writeTitle': '这个 pluginlet 要写文件',
      'writeBody': '点了「写入」才会落盘；不点，什么都不会发生。',
      'writeTarget': '目标',
      'writeBytes': '大小',
      'writeConfirm': '写入',
      'writeCancel': '取消',
      'frameTitle': 'Pluginlet',
      'wholeWorkspace': '整个工作区',
      'accessTitle': '运行中的 pluginlet 申请更多权限',
      'accessBody': '这次申请来自已经跑起来的 pluginlet。批准后会并入它的授权并立刻生效。',
      'accessScope': '申请的路径',
      'accessAllow': '允许',
      'accessDeny': '拒绝',
      'frameStarting': '正在启动 pluginlet…',
      'frameStalled': '帧一直没就绪。切到别的页签再回来会重新挂载；宿主审计里有记录。',
      'permSummary': '已授权 {n} 个 pluginlet',
      'permNone': '还没有授权',
      'permNote': '这里管理已经批准的内容。授权按内容哈希绑定，文件一改就失效；第一次批准仍然在它自己的页签里完成。',
      'permEmpty': '还没有任何授权。第一次打开某个 pluginlet 时，它的页签会逐条问你能力和路径。',
      'permRevoke': '撤销',
      'permWorking': '处理中…',
      'permSave': '保存修改',
      'permSaved': '已保存',
      'permAdd': '添加路径',
      'permRemove': '移除',
      'permNoScopes': '这条授权已经没有能力了，这个 pluginlet 什么也做不了',
      'permPathHint': '路径相对工作区根；填 ** 表示整个工作区',
      'permInvalid': '路径不能是绝对路径，也不能包含 ..',
      'dynamicPaths': '路径是运行时拼出来的，只能整仓库授权；要收窄就改成字面量或顶层 const。',
    }

const EN = {
      'view.label': 'Pluginlet',
      'blockedTitle': 'The static scan refused this source',
      'blockedBody': 'The source uses constructs the sandbox does not allow — dynamic evaluation, its own network, a bypass of the managed capabilities. Those can never be approved; remove them and scan again.',
      'blockedLine': 'line {line}',
      'grantTitle': 'This pluginlet asks for capabilities',
      'grantBody': 'The static scan found nothing forbidden, but the source wants the capabilities below. An approval covers this exact content: change a character and it lapses until you approve again.',
      'grantCaps': 'Requested capabilities and paths',
      'grantAllow': 'Allow',
      'grantHint': 'The capability switches and development mode live under Plugins → Pluginlet; this dialog only approves the content in front of you.',
      'stale': 'The content changed; approve it again.',
      'unavailable': 'Turned off by the plugin configuration:',
      'rescan': 'Rescan the workspace',
      'error': 'Something went wrong',
      'retry': 'Retry',
      'writeTitle': 'This pluginlet wants to write a file',
      'writeBody': 'Nothing reaches disk until you press Write.',
      'writeTarget': 'Target',
      'writeBytes': 'Size',
      'writeConfirm': 'Write',
      'writeCancel': 'Cancel',
      'frameTitle': 'Pluginlet',
      'wholeWorkspace': 'the whole workspace',
      'accessTitle': 'The running pluginlet asks for more reach',
      'accessBody': 'This request comes from a pluginlet that is already running. Approving merges it into the grant and takes effect at once.',
      'accessScope': 'Requested paths',
      'accessAllow': 'Allow',
      'accessDeny': 'Deny',
      'frameStarting': 'Starting the pluginlet…',
      'frameStalled': 'The frame never reported ready. Switch to another tab and back to remount it; the host audit has a record.',
      'permSummary': '{n} pluginlet(s) approved',
      'permNone': 'Nothing approved yet',
      'permNote': 'Approved content lives here. A grant is bound to the content hash, so editing the file lapses it; the first approval still happens in the pluginlet’s own tab.',
      'permEmpty': 'Nothing approved yet. The first time you open a pluginlet, its tab asks for capabilities and paths one by one.',
      'permRevoke': 'Revoke',
      'permWorking': 'Working…',
      'permSave': 'Save changes',
      'permSaved': 'Saved',
      'permAdd': 'Add path',
      'permRemove': 'Remove',
      'permNoScopes': 'This grant has no capability left; the pluginlet can do nothing',
      'permPathHint': 'Paths are workspace-relative; ** means the whole workspace',
      'permInvalid': 'A path cannot be absolute or contain ..',
      'dynamicPaths': 'The paths are built at runtime, so the approval can only cover the whole workspace. Use a literal or a top-level const to narrow it.',
    }

    let reportWindow = { start: 0, count: 0 }

    /** Send a client-side failure to the Host audit log (best effort, throttled). */
    function report(kind, message, root, path) {
      const now = Date.now()
      if (now - reportWindow.start > 60_000) {
        reportWindow = { start: now, count: 0 }
      }
      reportWindow.count += 1
      if (reportWindow.count > 20) return
      try {
        fetch(`${API}/client-event`, {
          method: 'POST',
          headers: HEADERS,
          credentials: 'same-origin',
          body: JSON.stringify({ kind, message: String(message ?? '').slice(0, 1500), root, path }),
        }).catch(() => {})
      } catch {
        // Reporting must never become its own failure.
      }
    }

    async function post(route, payload) {
      let response
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), 12_000)
      try {
        response = await fetch(`${API}/${route}`, {
          method: 'POST',
          headers: HEADERS,
          credentials: 'same-origin',
          signal: controller === null ? undefined : controller.signal,
          body: JSON.stringify(payload ?? {}),
        })
      } catch (error) {
        const aborted = controller !== null && controller.signal.aborted === true
        report('host-timeout', `${route}: ${aborted ? 'no answer in 12s' : String(error?.message ?? error)}`)
        throw Object.assign(new Error(aborted ? `${route} 12 秒没有响应` : String(error?.message ?? error)), {
          code: aborted ? 'TIMEOUT' : 'NETWORK',
        })
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || data === null || data.ok !== true) {
        const message = data?.error?.message ?? `HTTP ${response.status}`
        const code = data?.error?.code ?? `HTTP_${response.status}`
        report('host-error', `${route}: ${code} ${message}`)
        throw Object.assign(new Error(message), { code })
      }
      return data
    }

    /**
     * Scans are a pure function of the source bytes, so a result stays valid
     * for as long as the content hash does. `discover` hands us that hash per
     * file; keying on it means switching tabs away and back costs zero
     * requests, while an edited file simply misses.
     */
    const SCAN_CACHE_LIMIT = 64
    const scanCache = new Map()

    async function scanFor(root, path, knownHash) {
      const key = `${path}@${knownHash}`
      if (knownHash !== undefined && scanCache.has(key)) return scanCache.get(key)
      const scanned = await post('scan', { root, path })
      if (typeof scanned?.hash === 'string') {
        scanCache.set(`${path}@${scanned.hash}`, scanned)
        if (scanCache.size > SCAN_CACHE_LIMIT) scanCache.delete(scanCache.keys().next().value)
      }
      return scanned
    }

    function FRAME_RUNTIME() {
      'use strict'
      var rootEl = document.getElementById('root')
      var theme = {}
      var hooks = []
      var hookIndex = 0
      var effectQueue = []
      var scheduled = false
      var current = null
      var destroyed = true
      var seq = 0
      var calls = new Map()
      var api = null
      var component = null
      var renderFn = null
      var mode = 'component'
      var awaiting = null
      var meta = { name: '', path: '' }
      var scopes = {}

      var announceTimer = null

      function post(message) {
        parent.postMessage(Object.assign({ __we: 1 }, message), '*')
      }

      /**
       * Say "ready" until the host answers. The parent's listener may attach a
       * moment after this document runs; a one-shot post would be lost and the
       * panel would sit blank with nobody to blame.
       */
      function announceReady() {
        post({ t: 'ready' })
        if (announceTimer !== null) return
        var tries = 0
        announceTimer = setInterval(function () {
          tries += 1
          if (tries > 40) {
            clearInterval(announceTimer)
            announceTimer = null
            return
          }
          post({ t: 'ready' })
        }, 250)
      }

      function stopAnnouncing() {
        if (announceTimer === null) return
        clearInterval(announceTimer)
        announceTimer = null
      }

      function call(method, params) {
        return new Promise(function (resolve, reject) {
          var id = ++seq
          var timer = setTimeout(function () {
            calls.delete(id)
            reject(new Error('宿主没有响应：' + method))
          }, 30000)
          calls.set(id, { resolve: resolve, reject: reject, timer: timer })
          post({ t: 'call', id: id, method: method, params: params || {} })
        })
      }

      function normalize(value) {
        if (Array.isArray(value)) return { type: '#fragment', props: {}, children: value }
        return value
      }

      function h(type, props) {
        var children = []
        for (var i = 2; i < arguments.length; i++) {
          var value = arguments[i]
          if (value === null || value === undefined || value === false || value === true) continue
          if (Array.isArray(value)) {
            for (var j = 0; j < value.length; j++) children.push(value[j])
          } else children.push(value)
        }
        return { type: type, props: props || {}, children: children }
      }

      function applyProps(el, prev, next) {
        prev = prev || {}
        next = next || {}
        var key
        for (key in prev) {
          if (key === 'children' || key === 'key' || key === 'ref') continue
          if (!Object.prototype.hasOwnProperty.call(next, key)) setProp(el, key, undefined, prev[key])
        }
        for (key in next) {
          if (key === 'children' || key === 'key' || key === 'ref') continue
          if (prev[key] !== next[key]) setProp(el, key, next[key], prev[key])
        }
      }

      function setProp(el, key, value, previous) {
        if (key === 'style') {
          if (typeof value === 'string') {
            el.setAttribute('style', value)
            return
          }
          var prior = previous && typeof previous === 'object' ? previous : {}
          var style = value || {}
          var name
          for (name in prior) if (!Object.prototype.hasOwnProperty.call(style, name)) el.style[name] = ''
          for (name in style) {
            if (!Object.prototype.hasOwnProperty.call(style, name)) continue
            var v = style[name]
            el.style[name] = v === null || v === undefined ? '' : String(v)
          }
          return
        }
        if (key === 'className' || key === 'class') {
          if (value === null || value === undefined || value === '') el.removeAttribute('class')
          else el.setAttribute('class', String(value))
          return
        }
        if (key.length > 2 && key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && key.charCodeAt(2) >= 65 && key.charCodeAt(2) <= 90) {
          var type = key.slice(2).toLowerCase()
          var store = el.__weHandlers || (el.__weHandlers = {})
          if (store[key]) el.removeEventListener(type, store[key])
          store[key] = null
          if (typeof value === 'function') {
            store[key] = value
            el.addEventListener(type, value)
          }
          return
        }
        if (key === 'value') {
          var text = value === null || value === undefined ? '' : String(value)
          if (el.value !== text) el.value = text
          return
        }
        if (key === 'checked' || key === 'disabled' || key === 'readOnly' || key === 'selected' || key === 'multiple') {
          el[key] = value === true
          return
        }
        if (key === 'dangerouslySetInnerHTML' || key === 'innerHTML') return
        if (value === null || value === undefined || value === false) {
          el.removeAttribute(key)
          return
        }
        if (typeof value === 'object') {
          el.setAttribute(key, JSON.stringify(value))
          return
        }
        el.setAttribute(key, value === true ? '' : String(value))
      }

      function createNode(value) {
        if (value === null || value === undefined || value === false || value === true) return null
        if (typeof value === 'string' || typeof value === 'number') {
          return { kind: 'text', dom: document.createTextNode(String(value)), vnode: value }
        }
        var vnode = normalize(value)
        var tag = vnode.type === '#fragment' ? 'div' : String(vnode.type)
        var el = document.createElement(tag)
        if (vnode.type === '#fragment') el.setAttribute('data-we-fragment', '')
        var props = vnode.props || {}
        applyProps(el, {}, props)
        var children = []
        var list = vnode.children || []
        for (var i = 0; i < list.length; i++) {
          var child = createNode(list[i])
          if (child === null) continue
          children.push(child)
          el.appendChild(child.dom)
        }
        return { kind: 'element', dom: el, vnode: vnode, props: props, children: children, tag: tag }
      }

      function patch(pair, value) {
        if (value === null || value === undefined || value === false || value === true) {
          if (pair && pair.dom.parentNode) pair.dom.parentNode.removeChild(pair.dom)
          return null
        }
        var vnode = normalize(value)
        var isText = typeof vnode === 'string' || typeof vnode === 'number'
        if (pair === null) return createNode(vnode)
        if (pair.kind === 'text' && isText) {
          var text = String(vnode)
          if (pair.dom.data !== text) pair.dom.data = text
          pair.vnode = vnode
          return pair
        }
        if (pair.kind === 'element' && !isText) {
          var tag = vnode.type === '#fragment' ? 'div' : String(vnode.type)
          if (pair.tag === tag) {
            applyProps(pair.dom, pair.props, vnode.props || {})
            pair.props = vnode.props || {}
            pair.vnode = vnode
            var list = vnode.children || []
            var old = pair.children
            var kept = []
            for (var i = 0; i < list.length; i++) {
              var child = patch(old[i] || null, list[i])
              if (child === null) continue
              kept.push(child)
              var reference = pair.dom.childNodes[i] || null
              if (child.dom.parentNode !== pair.dom || child.dom !== reference) pair.dom.insertBefore(child.dom, reference)
            }
            for (var j = kept.length; j < old.length; j++) {
              if (old[j].dom.parentNode === pair.dom) pair.dom.removeChild(old[j].dom)
            }
            pair.children = kept
            return pair
          }
        }
        var replacement = createNode(vnode)
        if (replacement === null) {
          if (pair.dom.parentNode) pair.dom.parentNode.removeChild(pair.dom)
          return null
        }
        if (pair.dom.parentNode) pair.dom.parentNode.replaceChild(replacement.dom, pair.dom)
        return replacement
      }

      function sameDeps(left, right) {
        if (left === undefined || right === undefined) return false
        if (left.length !== right.length) return false
        for (var i = 0; i < left.length; i++) if (!Object.is(left[i], right[i])) return false
        return true
      }

      function useState(initial) {
        var index = hookIndex++
        if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
        var slot = hooks[index]
        if (slot.setter === undefined) {
          slot.setter = function (next) {
            slot.value = typeof next === 'function' ? next(slot.value) : next
            schedule()
          }
        }
        return [slot.value, slot.setter]
      }

      function useEffect(effect, deps) {
        var index = hookIndex++
        var slot = hooks[index] || (hooks[index] = { cleanup: null, deps: undefined })
        if (!sameDeps(slot.deps, deps)) effectQueue.push({ slot: slot, effect: effect, deps: deps })
      }

      function useMemo(factory, deps) {
        var index = hookIndex++
        var slot = hooks[index]
        if (slot === undefined || !sameDeps(slot.deps, deps)) slot = hooks[index] = { value: factory(), deps: deps }
        return slot.value
      }

      function useRef(initial) {
        var index = hookIndex++
        return hooks[index] || (hooks[index] = { current: initial === undefined ? null : initial })
      }

      function useCallback(fn, deps) {
        return useMemo(function () { return fn }, deps)
      }

      function reportError(error) {
        var message = error && error.message ? error.message : String(error)
        var box = document.createElement('div')
        box.className = 'we-frame-error'
        box.textContent = 'pluginlet 运行出错：' + message
        if (rootEl) rootEl.appendChild(box)
        post({ t: 'error', message: message })
      }

      function flushEffects() {
        var queue = effectQueue
        effectQueue = []
        for (var i = 0; i < queue.length; i++) {
          var item = queue[i]
          if (typeof item.slot.cleanup === 'function') {
            try { item.slot.cleanup() } catch (error) { reportError(error) }
          }
          item.slot.deps = item.deps
          try {
            var result = item.effect()
            item.slot.cleanup = typeof result === 'function' ? result : null
          } catch (error) {
            item.slot.cleanup = null
            reportError(error)
          }
        }
      }

      function render() {
        if (destroyed) return
        scheduled = false
        hookIndex = 0
        effectQueue = []
        var output
        try {
          output = mode === 'component' ? component(api) : renderFn(api)
        } catch (error) {
          reportError(error)
          return
        }
        if (output && typeof output.then === 'function') {
          if (awaiting !== null) return
          awaiting = output
          output.then(function (resolved) {
            awaiting = null
            if (destroyed) return
            var settled = patch(current, resolved)
            if (settled !== null && settled.dom.parentNode !== rootEl) {
              rootEl.innerHTML = ''
              rootEl.appendChild(settled.dom)
            }
            current = settled
            flushEffects()
          }, function (error) {
            awaiting = null
            reportError(error)
          })
          return
        }
        var next = patch(current, output)
        if (next !== null && next.dom.parentNode !== rootEl) {
          rootEl.innerHTML = ''
          rootEl.appendChild(next.dom)
        }
        current = next
        flushEffects()
      }

      function schedule() {
        if (scheduled || destroyed) return
        scheduled = true
        Promise.resolve().then(render)
      }

      function evaluate(source) {
        var code = String(source)
        code = code.replace(/^\s*export\s+default\s+/m, 'module.exports.default = ')
        code = code.replace(/^\s*export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)/gm, '')
        var module = { exports: {} }
        var factory = new Function('module', 'exports', 'dsh', '"use strict";\n' + code + '\n;return module.exports;')
        return factory(module, module.exports, api)
      }

      /** Mirror of the host's scope matcher, for `api.access.can`. */
      function scopeCovers(capability, target) {
        var list = scopes && scopes[capability]
        if (!list || list.length === 0) return false
        var path = String(target === undefined || target === null ? '' : target).replace(/^\.\//, '').replace(/\/+$/, '')
        if (path === '' || path === '.') return list.indexOf('**') >= 0
        for (var i = 0; i < list.length; i++) {
          var scope = list[i]
          if (scope === '**') return true
          if (scope.charAt(scope.length - 1) === '/') {
            if (path === scope.slice(0, -1) || path.indexOf(scope) === 0) return true
            continue
          }
          if (path === scope) return true
        }
        return false
      }

      function createApi() {
        return {
          version: 1,
          meta: meta,
          access: {
            scopes: function () { return scopes },
            can: function (capability, target) { return scopeCovers(capability, target) },
            request: function (capability, paths) {
              return call('access.request', { capability: capability, scopes: paths }).then(function (result) {
                if (result && result.scopes) scopes = result.scopes
                return result
              })
            },
          },
          h: h,
          Fragment: '#fragment',
          useState: useState,
          useEffect: useEffect,
          useMemo: useMemo,
          useRef: useRef,
          useCallback: useCallback,
          fs: {
            read: function (path) { return call('fs.read', { file: path }) },
            list: function (path) { return call('fs.list', { file: path === undefined ? null : path }) },
          },
          net: {
            fetch: function (url, init) { return call('net.fetch', { url: url, init: init || null }) },
          },
          write: {
            request: function (target, text, version) {
              return call('write.request', { target: target, text: text, version: version === undefined ? null : version })
            },
          },
          ui: {
            toast: function (message) {
              post({ t: 'toast', message: String(message) })
              return Promise.resolve(true)
            },
          },
        }
      }

      function teardown() {
        destroyed = true
        calls.forEach(function (entry) {
          clearTimeout(entry.timer)
          entry.reject(new Error('pluginlet 已卸载'))
        })
        calls.clear()
        for (var i = 0; i < hooks.length; i++) {
          var slot = hooks[i]
          if (slot && typeof slot.cleanup === 'function') {
            try { slot.cleanup() } catch (error) { /* unloading */ }
          }
        }
        hooks = []
        current = null
        if (rootEl) rootEl.innerHTML = ''
        component = null
        renderFn = null
        mode = 'component'
      }

      function boot(payload) {
        teardown()
        destroyed = false
        meta = payload.meta || meta
        scopes = payload.scopes || {}
        api = createApi()
        var exported
        try {
          exported = evaluate(payload.source)
        } catch (error) {
          reportError(error)
          return
        }
        var target = exported && exported.default !== undefined ? exported.default : exported
        if (typeof target === 'function') {
          component = target
          mode = 'component'
          render()
          return
        }
        if (target && typeof target.setup === 'function') {
          try {
            renderFn = target.setup(api)
          } catch (error) {
            reportError(error)
            return
          }
          mode = 'render'
          render()
          return
        }
        if (target && typeof target.mount === 'function') {
          mode = 'mount'
          try {
            target.mount(rootEl, api)
          } catch (error) {
            reportError(error)
          }
          return
        }
        reportError(new Error('pluginlet 必须 export default 一个组件函数、{ setup } 或 { mount }'))
      }

      function applyTheme() {
        var style = document.documentElement.style
        for (var key in theme) {
          if (!Object.prototype.hasOwnProperty.call(theme, key)) continue
          style.setProperty(key, theme[key])
        }
      }

      window.addEventListener('message', function (event) {
        var data = event.data
        if (!data || data.__we !== 1) return
        if (data.t !== 'ready') stopAnnouncing()
        if (data.t === 'init' || data.t === 'theme') {
          theme = data.theme || {}
          applyTheme()
          return
        }
        if (data.t === 'result') {
          var entry = calls.get(data.id)
          if (!entry) return
          calls.delete(data.id)
          clearTimeout(entry.timer)
          if (data.ok) entry.resolve(data.value)
          else {
            var failure = data.error || {}
            entry.reject(Object.assign(new Error(failure.message || '调用失败'), { code: failure.code || 'FAILED' }))
          }
          return
        }
        if (data.t === 'scopes') {
          scopes = data.scopes || {}
          return
        }
        if (data.t === 'mount') {
          boot(data)
          return
        }
        if (data.t === 'unmount') {
          teardown()
        }
      })

      announceReady()
    }

    const FRAME_CSS = [
      ':root{color-scheme:light dark}',
      'html,body{height:100%;margin:0}',
      'body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
      'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1b);overflow:auto}',
      '#root{min-height:100%;box-sizing:border-box}',
      'button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'border-radius:6px;padding:4px 10px;cursor:pointer}',
      'button:hover{background:var(--dsw-alias-bg-layer-3,#e9ebef)}',
      'input,textarea,select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#fff);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:6px;padding:4px 8px}',
      'code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      'a{color:var(--dsw-alias-brand-primary,#3f7ff2)}',
      '.we-frame-error{margin:12px;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-danger,#e5484d);',
      'background:color-mix(in srgb, var(--dsw-alias-border-danger,#e5484d) 12%, transparent);color:var(--dsw-alias-label-primary,#1b1b1b);',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}',
    ].join('')

    let frameDocument = null
    /**
     * Build the sandboxed document once. It is a separate document with an
     * opaque origin (sandbox without allow-same-origin) and a CSP that forbids
     * every network and resource load; the only channel out is postMessage.
     * @returns {string} srcdoc HTML for the pluginlet frame.
     */
    function buildFrameDocument() {
      if (frameDocument !== null) return frameDocument
      const csp = [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval'",
        "style-src 'unsafe-inline'",
        'img-src data: blob:',
        'font-src data:',
      ].join('; ')
      frameDocument = '<!doctype html><html><head><meta charset="utf-8">'
        + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
        + `<style>${FRAME_CSS}</style>`
        + '</head><body><div id="root"></div><script>('
        + FRAME_RUNTIME.toString()
        + ')();<' + '/script></body></html>'
      return frameDocument
    }

    /** Theme tokens handed to the frame so pluginlets inherit light/dark. */
    function collectTheme() {
      const style = getComputedStyle(document.documentElement)
      const keys = [
        '--dsw-alias-bg-layer-1',
        '--dsw-alias-bg-layer-2',
        '--dsw-alias-bg-layer-3',
        '--dsw-alias-label-primary',
        '--dsw-alias-label-secondary',
        '--dsw-alias-label-tertiary',
        '--dsw-alias-border-l2',
        '--dsw-alias-brand-primary',
      ]
      const theme = {}
      for (const key of keys) {
        const value = style.getPropertyValue(key).trim()
        if (value !== '') theme[key] = value
      }
      return theme
    }

    function humanSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    }

    /* ── tab registry ──────────────────────────────────────────────────
     * The workspace of the session on screen decides which tabs exist. A
     * renderless probe in the session header reports that session; whenever it
     * changes we drop the old registrations and register one Conversation View
     * per `*.pluginlet` file. Nothing is scanned or loaded until a tab is opened.
     */

    let ctxRef = null
    let activeSession = null
    let activeRoot = null
    let disposers = []
    let known = new Map()
    let syncSeq = 0

    function disposeTabs() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          // A registration already gone is not a problem.
        }
      }
      disposers = []
      known = new Map()
    }

    async function syncTabs(root) {
      const seq = ++syncSeq
      disposeTabs()
      if (root === null || ctxRef === null) return
      let discovered
      try {
        discovered = await post('discover', { root })
      } catch (error) {
        return
      }
      if (seq !== syncSeq || activeRoot !== root || ctxRef === null) return
      const items = Array.isArray(discovered.items) ? discovered.items : []
      items.forEach((item, index) => {
        const id = `we:${item.relative}`
        known.set(id, item)
        try {
          disposers.push(ctxRef.slots.register({
            name: 'conversation.view',
            id,
            order: 40 + index,
            locale: NS,
            label: () => known.get(id)?.name ?? item.name,
            inject: (sessionId) => ({ sessionId, root, path: item.path, name: item.name, hash: item.hash }),
          }, EditorTab))
        } catch (error) {
          // A surviving duplicate id means the previous generation was not
          // disposed; skipping this one keeps the tab bar usable.
        }
      })
    }

    function noteSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      let root = null
      try {
        const row = ctxRef?.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
        if (row !== undefined && typeof row.cwd === 'string' && row.cwd !== '') root = row.cwd
      } catch {
        root = null
      }
      // Compare the workspace, not just the session id: a header can render
      // before the catalog row carrying `cwd` exists, and the later render must
      // still be allowed to register the tabs.
      if (sessionId === activeSession && root === activeRoot) return
      activeSession = sessionId
      activeRoot = root
      syncTabs(root)
    }

    /** Renderless header occupant: reports the Session that is on screen. */
    function SessionProbe(props) {
      const sessionId = props.sessionId
      queueMicrotask(() => noteSession(sessionId))
      return null
    }

    /* ── one pluginlet tab ───────────────────────────────────────────── */

    function EditorTab(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const root = props.root
      const path = props.path

      const [phase, setPhase] = React.useState('scanning')
      const [scan, setScan] = React.useState(null)
      const [denied, setDenied] = React.useState(null)
      const [error, setError] = React.useState('')
      const [active, setActive] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [toast, setToast] = React.useState('')
      const [epoch, setEpoch] = React.useState(0)
      const [readyEpoch, setReadyEpoch] = React.useState(-1)
      const [stalled, setStalled] = React.useState(false)
      const [slowStart, setSlowStart] = React.useState(false)
      const epochRef = React.useRef(0)
      epochRef.current = epoch
      const [writeRequest, setWriteRequest] = React.useState(null)
      const [accessRequest, setAccessRequest] = React.useState(null)
      const [selected, setSelected] = React.useState({})

      const frameRef = React.useRef(null)
      const activeRef = React.useRef(null)
      const budget = React.useRef({ start: 0, count: 0 })
      const writeResolver = React.useRef(null)
      const accessResolver = React.useRef(null)

      React.useEffect(() => {
        activeRef.current = active
      }, [active])

      // A frame usually announces itself in well under 400 ms. Waiting before
      // showing "starting…" keeps a fast mount from flashing a label.
      React.useEffect(() => {
        if (readyEpoch === epoch) {
          setSlowStart(false)
          return undefined
        }
        const timer = setTimeout(() => setSlowStart(true), 400)
        return () => clearTimeout(timer)
      }, [epoch, readyEpoch])

      const load = React.useCallback(async () => {
        // A reload replaces the frame document: bump the epoch so the mount
        // waits for THIS frame's ready instead of the previous one's.
        setEpoch((value) => value + 1)
        setPhase('scanning')
        setError('')
        setDenied(null)
        setActive(null)
        try {
          const scanned = await scanFor(root, path, props.hash)
          setScan(scanned)
          const initial = {}
          for (const capability of scanned.capabilities ?? []) {
            const list = scanned.scopes?.[capability] ?? ['**']
            initial[capability] = {}
            for (const scope of list) initial[capability][scope] = true
          }
          setSelected(initial)
          if (Array.isArray(scanned.blocked) && scanned.blocked.length > 0) {
            setPhase('blocked')
            return
          }
          const loaded = await post('source', { root, path, hash: scanned.hash })
          if (loaded.denied === true) {
            setDenied({
              reason: loaded.reason ?? 'no-grant',
              capabilities: loaded.capabilities ?? [],
              unavailable: loaded.unavailable ?? [],
              scopes: loaded.scopes ?? scanned.scopes ?? {},
              dynamic: loaded.dynamic ?? scanned.dynamic ?? {},
            })
            setPhase('denied')
            return
          }
          setActive({
            source: loaded.source,
            hash: loaded.hash,
            capabilities: loaded.capabilities ?? [],
            unavailable: loaded.unavailable ?? [],
            scopes: loaded.scopes ?? {},
            notes: loaded.notes ?? [],
            devMode: loaded.devMode === true,
          })
          setPhase('ready')
        } catch (failure) {
          setError(failure.message ?? String(failure))
          setPhase('error')
        }
      }, [root, path])

      React.useEffect(() => {
        report('phase', `${phase} ${path}`, root, path)
      }, [phase, root, path])

      React.useEffect(() => {
        load()
      }, [load, tick])

      React.useEffect(() => {
        if (toast === '') return undefined
        const timer = setTimeout(() => setToast(''), 4000)
        return () => clearTimeout(timer)
      }, [toast])

      const send = React.useCallback((type, payload) => {
        const frame = frameRef.current
        if (!frame || !frame.contentWindow) return
        frame.contentWindow.postMessage({ __we: 1, t: type, ...(payload ?? {}) }, '*')
      }, [])

      const reply = React.useCallback((id, ok, value) => {
        const frame = frameRef.current
        if (!frame || !frame.contentWindow) return
        frame.contentWindow.postMessage(
          ok ? { __we: 1, t: 'result', id, ok: true, value } : { __we: 1, t: 'result', id, ok: false, error: value },
          '*',
        )
      }, [])

      const askWrite = React.useCallback((request) => new Promise((resolve) => {
        writeResolver.current = resolve
        setWriteRequest(request)
      }), [])

      const askAccess = React.useCallback((request) => new Promise((resolve) => {
        accessResolver.current = resolve
        setAccessRequest(request)
      }), [])

      const settleAccess = React.useCallback((ok) => {
        const resolve = accessResolver.current
        accessResolver.current = null
        setAccessRequest(null)
        if (typeof resolve === 'function') resolve(ok)
      }, [])

      const settleWrite = React.useCallback((ok) => {
        const resolve = writeResolver.current
        writeResolver.current = null
        setWriteRequest(null)
        if (typeof resolve === 'function') resolve(ok)
      }, [])

      const handleCall = React.useCallback(async (message) => {
        const source = activeRef.current
        const now = Date.now()
        const bucket = budget.current
        if (now - bucket.start > CALL_WINDOW_MS) {
          bucket.start = now
          bucket.count = 0
        }
        bucket.count += 1
        if (bucket.count > CALL_WINDOW_MAX) {
          reply(message.id, false, { code: 'RATE_LOCAL', message: 'pluginlet 调用过于频繁' })
          return
        }
        try {
          if (source === null) throw new Error('pluginlet 尚未加载')
          const params = message.params ?? {}
          // Editors address the workspace relatively ('.', 'README.md'); the
          // Host only accepts absolute paths, so the bridge resolves them. The
          // Host still re-checks containment, so '..' cannot escape.
          const resolveTarget = (file) => {
            if (typeof file !== 'string' || file === '') return root
            if (file.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(file)) return file
            return `${root.replace(/\/+$/, '')}/${file.replace(/^\.\//, '')}`
          }
          let value
          if (message.method === 'fs.read' || message.method === 'fs.list') {
            const route = message.method === 'fs.read' ? 'fs/read' : 'fs/list'
            value = await post(route, { root, path, hash: source.hash, file: resolveTarget(params.file) })
          } else if (message.method === 'net.fetch') {
            value = await post('net/fetch', { root, path, hash: source.hash, url: params.url, init: params.init ?? null })
          } else if (message.method === 'access.request') {
            const capability = String(params.capability ?? '')
            const requested = Array.isArray(params.scopes) ? params.scopes.map(String) : []
            if (capability === '' || requested.length === 0) throw new Error('缺少申请的权限或路径')
            const approved = await askAccess({ capability, scopes: requested })
            if (!approved) {
              reply(message.id, false, { code: 'DENIED', message: '用户拒绝了这次申请' })
              return
            }
            const result = await post('grant', {
              root,
              path,
              hash: source.hash,
              merge: true,
              capabilities: [capability],
              scopes: { [capability]: requested },
            })
            const scopes = result.grants?.[path]?.scopes ?? source.scopes ?? {}
            setActive((current) => (current === null ? current : { ...current, scopes }))
            reply(message.id, true, { granted: true, scopes })
            return
          } else if (message.method === 'write.request') {
            const approved = await askWrite({ target: params.target, text: params.text, version: params.version })
            if (!approved) {
              reply(message.id, false, { code: 'CANCELLED', message: '用户取消了写入' })
              return
            }
            value = await post('write', {
              root,
              path,
              hash: source.hash,
              target: resolveTarget(params.target),
              text: params.text,
              version: params.version,
              confirmed: true,
            })
          } else {
            throw new Error(`未知能力 ${message.method}`)
          }
          reply(message.id, true, value)
        } catch (failure) {
          reply(message.id, false, { code: failure.code ?? 'FAILED', message: failure.message ?? String(failure) })
        }
      }, [askWrite, reply, root, path])

      React.useEffect(() => {
        function onMessage(event) {
          const frame = frameRef.current
          if (!frame || event.source !== frame.contentWindow) return
          const data = event.data
          if (!data || data.__we !== 1) return
          if (data.t === 'ready') {
            // The frame announces itself; accept it for the CURRENT epoch only,
            // so a message from a replaced document cannot mount the new one.
            setReadyEpoch(epochRef.current)
            return
          }
          if (data.t === 'call') {
            handleCall(data)
            return
          }
          if (data.t === 'toast') {
            setToast(String(data.message ?? ''))
            return
          }
          if (data.t === 'error') {
            setToast(`${t('error')}: ${data.message}`)
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [handleCall, t])

      React.useEffect(() => {
        if (active === null || readyEpoch === epoch) {
          setStalled(false)
          return undefined
        }
        const timer = setTimeout(() => {
          setStalled(true)
          report('frame-stall', `epoch ${epoch} never reported ready`, root, path)
        }, 2500)
        return () => clearTimeout(timer)
      }, [active, readyEpoch, epoch, root, path])

      React.useEffect(() => {
        if (readyEpoch !== epoch || active === null) return
        report('mounted', `epoch ${epoch} ready`, root, path)
        const theme = collectTheme()
        send('init', { theme })
        send('theme', { theme })
        send('mount', {
          source: active.source,
          hash: active.hash,
          meta: { name: props.name, path },
          scopes: active.scopes ?? {},
        })
      }, [active, readyEpoch, epoch, send, props.name, path])

      // A grant obtained at runtime is pushed to the frame so `api.access` and
      // a later mount see the same answer.
      React.useEffect(() => {
        if (readyEpoch !== epoch || active === null) return
        send('scopes', { scopes: active.scopes ?? {} })
      }, [active?.scopes, readyEpoch, epoch, send])

      const allow = React.useCallback(async () => {
        if (scan === null) return
        try {
          const capabilities = []
          const scopes = {}
          for (const capability of scan.capabilities ?? []) {
            const ticks = selected[capability] ?? {}
            const paths = Object.keys(ticks).filter((scope) => ticks[scope] === true)
            if (paths.length === 0) continue
            capabilities.push(capability)
            scopes[capability] = paths
          }
          await post('grant', { root, path, hash: scan.hash, capabilities, scopes })
          setTick((value) => value + 1)
        } catch (failure) {
          setToast(failure.message ?? String(failure))
        }
      }, [root, path, scan, selected])

      const rescan = React.useCallback(() => {
        syncTabs(activeRoot)
      }, [])

      const card = (title, body, extra, actions) => h('div', { className: 'we-card' },
        h('h3', null, title),
        h('p', null, body),
        extra,
        h('div', { className: 'we-actions' }, actions))

      const shell = (children) => h('div', { className: 'we-tab' },
        h('style', null, CSS),
        children,
        toast !== '' ? h('div', { className: 'we-toast' }, toast) : null)

      if (phase === 'scanning') {
        // No label here: a cache hit resolves in the same tick, and a line that
        // appears and vanishes reads as jank rather than progress.
        return shell(h('div', { className: 'we-center' }))
      }

      if (phase === 'error') {
        return shell(h('div', { className: 'we-center' },
          card(t('error'), error, null, [
            h('button', { key: 'retry', type: 'button', className: 'we-btn we-btn-primary', onClick: () => setTick((value) => value + 1) }, t('retry')),
            h('button', { key: 'rescan', type: 'button', className: 'we-btn', onClick: rescan }, t('rescan')),
          ])))
      }

      if (phase === 'blocked') {
        const blocked = Array.isArray(scan?.blocked) ? scan.blocked : []
        const items = blocked.map((block, index) => h('li', { key: index },
          h('code', { className: 'we-rule' }, block.rule),
          h('span', { className: 'we-dim' }, ` ${t('blockedLine').replace('{line}', String(block.line))}`),
          h('div', { className: 'we-excerpt' }, block.excerpt),
          h('div', { className: 'we-hint' }, block.hint)))
        return shell(h('div', { className: 'we-center' }, card(
          t('blockedTitle'),
          t('blockedBody'),
          h('ul', { className: 'we-blocks' }, items),
          [
            h('button', { key: 'rescan', type: 'button', className: 'we-btn', onClick: rescan }, t('rescan')),
            h('button', { key: 'retry', type: 'button', className: 'we-btn', onClick: () => setTick((value) => value + 1) }, t('retry')),
          ],
        )))
      }

      if (phase === 'denied') {
        const capabilities = Array.isArray(denied?.capabilities) ? denied.capabilities : []
        const unavailable = Array.isArray(denied?.unavailable) ? denied.unavailable : []
        const scopes = denied?.scopes ?? {}
        const describe = (capability) => {
          const list = scopes[capability]
          if (!Array.isArray(list) || list.length === 0 || list.includes('**')) return t('wholeWorkspace')
          return list.join('   ')
        }
        const dynamic = denied?.dynamic ?? {}
        const toggle = (capability, scope) => setSelected((current) => {
          const next = { ...current, [capability]: { ...(current[capability] ?? {}) } }
          next[capability][scope] = !next[capability][scope]
          return next
        })
        const rows = []
        for (const capability of capabilities) {
          const list = Array.isArray(scopes[capability]) && scopes[capability].length > 0 ? scopes[capability] : ['**']
          rows.push(h('li', { key: capability + ':cap', className: 'we-cap-row' }, h('code', null, capability)))
          for (const scope of list) {
            const ticked = (selected[capability] ?? {})[scope] === true
            rows.push(h('li', { key: capability + ':' + scope, className: 'we-scope-row' },
              h('label', null,
                h('input', {
                  type: 'checkbox',
                  checked: ticked,
                  onChange: () => toggle(capability, scope),
                }),
                h('span', { className: 'we-scope' }, scope === '**' ? t('wholeWorkspace') : scope))))
          }
        }
        const detail = h('div', null,
          h('div', { className: 'we-section' }, t('grantCaps')),
          h('ul', { className: 'we-caps' }, rows),
          Object.keys(dynamic).some((key) => dynamic[key] === true)
            ? h('div', { className: 'we-note' }, t('dynamicPaths'))
            : null,
          unavailable.length > 0 ? h('div', { className: 'we-note' }, `${t('unavailable')} ${unavailable.join(', ')}`) : null,
          h('div', { className: 'we-hint' }, t('grantHint')))
        return shell(h('div', { className: 'we-center' }, card(
          t('grantTitle'),
          denied?.reason === 'hash-mismatch' ? t('stale') : t('grantBody'),
          detail,
          [
            (() => {
              const any = capabilities.some((capability) => Object.values(selected[capability] ?? {}).some((value) => value === true))
              return h('button', { key: 'allow', type: 'button', className: 'we-btn we-btn-primary', onClick: allow, disabled: !any }, t('grantAllow'))
            })(),
            h('button', { key: 'rescan', type: 'button', className: 'we-btn', onClick: rescan }, t('rescan')),
          ],
        )))
      }

      return shell(h('div', { className: 'we-pane' },
        // The tab shows the work, not the permissions: what a pluginlet may
        // touch belongs to the approval card and the Plugins page.
        readyEpoch === epoch || (!stalled && !slowStart)
          ? null
          : h('div', { className: 'we-frame-note' }, stalled ? t('frameStalled') : t('frameStarting')),
        h('div', { className: 'we-frame-wrap' },
          h('iframe', {
            key: epoch,
            ref: frameRef,
            title: t('frameTitle'),
            // The frame paints its own background, but not before its document
            // parses; matching the tab avoids a white flash on a dark theme.
            style: { background: 'var(--dsw-alias-bg-layer-1, #fff)' },
            sandbox: 'allow-scripts',
            srcDoc: buildFrameDocument(),
            className: 'we-frame',
            // Deliberately NOT a readiness signal: `load` fires even when the
            // frame's script was blocked, which is exactly the blank-panel case
            // the note and the watchdog exist for.
            onLoad: () => undefined,
          })),
        accessRequest === null ? null : h('div', { className: 'we-modal-backdrop' },
          h('div', { className: 'we-modal', role: 'dialog', 'aria-modal': 'true' },
            h('h3', null, t('accessTitle')),
            h('p', null, t('accessBody')),
            h('div', { className: 'we-section' }, t('accessScope')),
            h('ul', { className: 'we-caps' },
              h('li', { key: 'cap' }, h('code', null, accessRequest.capability)),
              accessRequest.scopes.map((scope) => h('li', { key: scope }, h('code', null, scope)))),
            h('div', { className: 'we-actions' },
              h('button', { type: 'button', className: 'we-btn', onClick: () => settleAccess(false) }, t('accessDeny')),
              h('button', { type: 'button', className: 'we-btn we-btn-primary', onClick: () => settleAccess(true) }, t('accessAllow'))))),
        writeRequest === null ? null : h('div', { className: 'we-modal-backdrop' },
          h('div', { className: 'we-modal', role: 'dialog', 'aria-modal': 'true' },
            h('h3', null, t('writeTitle')),
            h('p', null, t('writeBody')),
            h('div', { className: 'we-meta' }, h('span', null, t('writeTarget')), h('code', null, String(writeRequest.target ?? ''))),
            h('div', { className: 'we-meta' },
              h('span', null, t('writeBytes')),
              h('code', null, humanSize(typeof writeRequest.text === 'string' ? new TextEncoder().encode(writeRequest.text).length : 0))),
            h('pre', { className: 'we-preview' }, String(writeRequest.text ?? '').slice(0, 600)),
            h('div', { className: 'we-actions' },
              h('button', { type: 'button', className: 'we-btn', onClick: () => settleWrite(false) }, t('writeCancel')),
              h('button', { type: 'button', className: 'we-btn we-btn-primary', onClick: () => settleWrite(true) }, t('writeConfirm')))))))
    }

    const CSS = `
.we-tab{flex:1 1 auto;display:flex;flex-direction:column;min-height:320px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary,#1b1b1b);background:var(--dsw-alias-bg-layer-1,#fff);position:relative}
.we-center{flex:1 1 auto;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:28px 24px}
.we-card{width:min(620px,100%);display:flex;flex-direction:column;gap:8px}
.we-card h3{margin:0;font-size:15px}
.we-card p{margin:0;color:var(--dsw-alias-label-secondary,#5b6068);line-height:1.6}
.we-section{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#8a8f98);margin:12px 0 4px}
.we-caps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.we-caps li{margin:0}
.we-cap-row{margin-top:8px;font:600 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#5b6068)}
.we-scope-row{margin:0}
.we-scope-row label{display:flex;align-items:center;gap:8px;cursor:pointer;padding:2px 0;border-radius:6px}
.we-scope-row label:hover{background:var(--dsw-alias-bg-layer-2,#f4f5f7)}
.we-scope-row input{accent-color:var(--dsw-alias-brand-primary,#3f7ff2);flex:0 0 auto;margin:0}
.we-scope{margin-left:2px;color:var(--dsw-alias-label-secondary,#5b6068);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.we-note{margin-top:8px;font-size:12px;color:var(--dsw-alias-border-warning,#b45309)}
.we-hint{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.5}
.we-actions{display:flex;gap:8px;margin-top:12px}
.we-pane{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
.we-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5b6068);background:var(--dsw-alias-bg-layer-2,#f4f5f7);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:6px;padding:4px 10px;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}
.we-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,#e9ebef);color:var(--dsw-alias-label-primary,#1b1b1b)}
.we-btn-primary{background:var(--dsw-alias-brand-primary,#3f7ff2);border-color:transparent;color:#fff}
.we-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#3f7ff2);filter:brightness(1.06);color:#fff}
.we-perm{display:flex;flex-direction:column;gap:12px;font-size:13px;padding:2px 0}
.we-perm-note{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:1.6}
.we-perm-empty{padding:14px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:8px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}
.we-perm-ws{display:flex;flex-direction:column;gap:8px}
.we-perm-ws-head{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#5b6068);border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding-bottom:4px}
.we-perm-row{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}
.we-perm-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.we-perm-file{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.we-perm-scope{display:flex;gap:10px;align-items:flex-start;font-size:11px;color:var(--dsw-alias-label-secondary,#5b6068);margin-top:4px}
.we-perm-scope code{color:var(--dsw-alias-label-primary,#1b1b1b)}
.we-perm-scope span{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.we-perm-meta{display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.we-frame-wrap{flex:1 1 auto;min-height:280px;position:relative}
.we-frame-note{position:absolute;left:50%;top:44px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));font-size:12px;color:var(--dsw-alias-label-secondary,#5b6068);z-index:2}
.we-frame{width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-layer-1,#fff)}
.we-blocks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.we-blocks li{border-left:2px solid var(--dsw-alias-border-danger,#e5484d);padding-left:10px}
.we-rule{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-border-danger,#e5484d);font-size:12px}
.we-excerpt{margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);padding:6px 8px;border-radius:6px;overflow:auto}
.we-dim{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.we-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:var(--dsw-alias-bg-layer-3,#2b2f36);color:var(--dsw-alias-label-primary,#fff);padding:7px 14px;border-radius:999px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.24);z-index:30}
.we-modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;z-index:20}
.we-modal{width:min(560px,92vw);max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;padding:18px 20px;box-shadow:0 18px 48px rgba(0,0,0,.24)}
.we-modal h3{margin:0 0 6px;font-size:15px}
.we-modal p{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#5b6068);line-height:1.6}
.we-meta{display:flex;gap:8px;align-items:baseline;margin:6px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6068)}
.we-preview{margin:8px 0 0;max-height:200px;overflow:auto;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap}
/* ── permission page ────────────────────────────────────────────────── */
.we-error{margin:6px 0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#1b1b1b);border:1px solid color-mix(in srgb, var(--dsw-alias-border-danger,#e5484d) 55%, transparent);background:color-mix(in srgb, var(--dsw-alias-border-danger,#e5484d) 10%, transparent)}
.we-perm-root{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#5b6068);word-break:break-all}
.we-perm-cap{flex:0 0 104px;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#5b6068);padding-top:2px}
.we-perm-chips{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.we-perm-chip{display:inline-flex;align-items:center;gap:2px;max-width:100%;padding:0 2px 0 7px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-2,#f4f5f7);font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary,#1b1b1b)}
.we-perm-chip>span{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.we-perm-x{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font:13px/1 system-ui,sans-serif;cursor:pointer;flex:0 0 auto}
.we-perm-x:hover{background:color-mix(in srgb, var(--dsw-alias-border-danger,#e5484d) 18%, transparent);color:var(--dsw-alias-border-danger,#e5484d)}
.we-perm-plus{border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.2));color:var(--dsw-alias-label-secondary,#5b6068)}
.we-perm-plus:hover{border-style:solid;background:var(--dsw-alias-bg-layer-2,#f4f5f7);color:var(--dsw-alias-label-primary,#1b1b1b)}
.we-perm-input{width:128px;height:20px;margin:0;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1b);font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;min-width:0}
.we-perm-input::placeholder{color:var(--dsw-alias-label-tertiary,#a1a6ae)}
.we-perm-input:focus{border-color:var(--dsw-alias-brand-primary,#3f7ff2);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary,#3f7ff2) 22%, transparent)}
.we-perm-note-inline{color:var(--dsw-alias-border-warning,#b45309)}
.we-perm-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-top:4px}
.we-perm-actions{display:flex;flex-direction:column;gap:6px;flex:0 0 100px;align-self:stretch;justify-content:flex-start}
.we-perm-actions .we-btn{width:100%;justify-content:center;text-align:center}
`

    /** Stable selector so the workspace hook does not resubscribe each render. */
    const WORKSPACE_ROOTS = (snapshot) => (snapshot?.items ?? []).map((item) => item.path).filter((path) => typeof path === 'string')
    const NO_ROOTS = []

    /* ── permission page in the sidebar's Plugins panel ───────────────── */

    /**
     * One approved pluginlet, editable: every capability keeps its own path list,
     * paths can be added and removed, and saving rewrites the grant for the SAME
     * content hash (the content did not change, only its reach).
     */
    function GrantRow(props) {
      const t = props.t
      const root = props.root
      const path = props.path
      const record = props.record ?? {}
      const [draft, setDraft] = React.useState(() => {
        const next = {}
        for (const [capability, list] of Object.entries(record.scopes ?? {})) next[capability] = Array.from(list ?? [])
        return next
      })
      const [adding, setAdding] = React.useState({})
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')

      const capabilities = Object.keys(draft)
      const dirty = JSON.stringify(draft) !== JSON.stringify(record.scopes ?? {})

      function change(capability, paths) {
        setDraft((current) => ({ ...current, [capability]: paths }))
        setNote('')
      }

      function remove(capability, scope) {
        const paths = (draft[capability] ?? []).filter((entry) => entry !== scope)
        if (paths.length === 0) {
          setDraft((current) => {
            const next = { ...current }
            delete next[capability]
            return next
          })
          return
        }
        change(capability, paths)
      }

      function add(capability) {
        const raw = (adding[capability] ?? '').trim()
        if (raw === '') return
        const scope = raw === '**' ? '**' : raw.replace(/^\.\//, '').replace(/\/+$/, '')
        if (scope !== '**' && (scope.startsWith('/') || scope.split('/').includes('..'))) {
          setNote(t('permInvalid'))
          return
        }
        change(capability, Array.from(new Set([...(draft[capability] ?? []), scope])))
        setAdding((current) => ({ ...current, [capability]: '' }))
      }

      async function save() {
        const chosen = Object.keys(draft).filter((capability) => (draft[capability] ?? []).length > 0)
        if (chosen.length === 0) {
          setNote(t('permNoScopes'))
          return
        }
        setBusy('save')
        try {
          const scopes = {}
          for (const capability of chosen) scopes[capability] = draft[capability]
          await post('grant', { root, path, hash: record.hash, capabilities: chosen, scopes })
          setNote(t('permSaved'))
          props.onChanged()
        } catch (failure) {
          setNote(failure.message ?? String(failure))
        } finally {
          setBusy('')
        }
      }

      async function revoke() {
        setBusy('revoke')
        try {
          await post('revoke', { root, path })
          props.onChanged()
        } catch (failure) {
          setNote(failure.message ?? String(failure))
        } finally {
          setBusy('')
        }
      }

      const capabilityRows = capabilities.map((capability) => h('div', { key: capability, className: 'we-perm-scope' },
        h('code', { className: 'we-perm-cap' }, capability),
        h('span', { className: 'we-perm-chips' },
          (draft[capability] ?? []).map((scope) => h('span', { key: scope, className: 'we-perm-chip' },
            h('span', null, scope === '**' ? '**' : scope),
            h('button', {
              type: 'button',
              className: 'we-perm-x',
              title: t('permRemove'),
              onClick: () => remove(capability, scope),
            }, '×'))),
          h('input', {
            className: 'we-perm-input',
            value: adding[capability] ?? '',
            placeholder: t('permAdd'),
            onInput: (event) => setAdding((current) => ({ ...current, [capability]: event.target.value })),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add(capability)
              }
            },
          }),
          h('button', { type: 'button', className: 'we-perm-x we-perm-plus', title: t('permAdd'), onClick: () => add(capability) }, '+'))))

      const head = h('div', { className: 'we-perm-file' }, path.startsWith(root) ? path.slice(root.length + 1) : path)
      const emptyLine = h('div', { className: 'we-perm-scope' }, h('span', null, t('permNoScopes')))
      const meta = h('div', { className: 'we-perm-meta' },
        h('code', null, String(record.hash ?? '').slice(0, 12)),
        record.at ? h('span', null, new Date(record.at).toLocaleString()) : null,
        note === '' ? null : h('span', { className: 'we-perm-note-inline' }, note))
      const hint = h('div', { className: 'we-perm-hint' }, t('permPathHint'))
      const main = h('div', { className: 'we-perm-main' },
        head,
        capabilityRows.length === 0 ? emptyLine : capabilityRows,
        meta,
        hint)
      const actions = h('div', { className: 'we-perm-actions' },
        h('button', {
          type: 'button',
          className: 'we-btn we-btn-primary',
          disabled: !dirty || busy !== '',
          onClick: save,
        }, busy === 'save' ? t('permWorking') : t('permSave')),
        h('button', {
          type: 'button',
          className: 'we-btn',
          disabled: busy !== '',
          onClick: revoke,
        }, busy === 'revoke' ? t('permWorking') : t('permRevoke')))

      return h('div', { className: 'we-perm-row' }, main, actions)
    }

    /**
     * The row's configuration page. It lists every approved pluginlet per
     * workspace and can edit or revoke one; approvals themselves are still
     * asked at the moment a pluginlet wants to run, because only then does the
     * person know what it is about to do.
     */
    function PermissionsPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const view = props.view === 'summary' ? 'summary' : 'page'
      const [workspaces, setWorkspaces] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [generation, setGeneration] = React.useState(0)

      // Registered workspaces come from the standard workspace hook, so the page
      // needs no extra Host route: it asks each root's own `state`.
      const useWorkspaces = props.useWorkspaces
      const roots = typeof useWorkspaces === 'function' ? useWorkspaces(WORKSPACE_ROOTS) : NO_ROOTS

      const refresh = React.useCallback(() => {
        setGeneration((value) => value + 1)
      }, [])

      React.useEffect(() => {
        let cancelled = false
        Promise.all((roots ?? []).map((root) => post('state', { root }).then(
          (value) => ({ root, grants: value.grants ?? {} }),
          () => ({ root, grants: {} }),
        ))).then((list) => {
          if (cancelled) return
          setWorkspaces(list)
          setError('')
        })
        return () => { cancelled = true }
      }, [Array.isArray(roots) ? roots.join('|') : '', generation])

      const total = (workspaces ?? []).reduce((sum, workspace) => sum + Object.keys(workspace.grants ?? {}).length, 0)

      if (view === 'summary') {
        return h('span', null, total === 0 ? t('permNone') : t('permSummary').replace('{n}', String(total)))
      }

      return h('div', { className: 'we-perm' },
        h('style', null, CSS),
        h('div', { className: 'we-perm-note' }, t('permNote')),
        error === '' ? null : h('div', { className: 'we-error' }, error),
        workspaces === null
          ? h('div', { className: 'we-perm-empty' }, t('permWorking'))
          : total === 0
            ? h('div', { className: 'we-perm-empty' }, t('permEmpty'))
            : workspaces.filter((workspace) => Object.keys(workspace.grants ?? {}).length > 0).map((workspace) => h('div', {
              key: workspace.root,
              className: 'we-perm-ws',
            },
            h('div', { className: 'we-perm-ws-head' }, h('span', { className: 'we-perm-root', title: workspace.root }, workspace.root)),
            Object.entries(workspace.grants ?? {}).map(([path, record]) => h(GrantRow, {
              key: `${workspace.root}|${path}|${record.hash}`,
              t,
              root: workspace.root,
              path,
              record,
              onChanged: refresh,
            })))))
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        ctxRef = ctx
        try {
          window.addEventListener('error', (event) => {
            report('window-error', `${event?.message ?? 'error'} @ ${event?.filename ?? '?'}:${event?.lineno ?? 0}`)
          })
          window.addEventListener('unhandledrejection', (event) => {
            report('unhandled', String(event?.reason?.message ?? event?.reason ?? 'rejection'))
          })
        } catch {
          // A non-browser host simply has no window.
        }
        // One failing registration must not take the others down, and the
        // reason has to reach the host: the browser console is not readable
        // from the plugin. `client-event` lands in the audit log.
        const seat = (label, produce) => {
          try {
            ctx.effect(produce, label)
          } catch (error) {
            report('apply-error', `${label}: ${error?.message ?? error}`)
          }
        }
        seat(
          'pluginlet: dictionaries',
          () => ctx.locale.register(NS, { zh: ZH, en: EN }),
        )
        // A renderless seat in the session header: it tells the registry which
        // workspace is on screen. Nothing renders, so the header is untouched.
        seat(
          'pluginlet: session probe',
          () => ctx.slots.inject('conversation.session.header.actions', () =>
            ctx.slots.register({
              name: 'conversation.session.header.actions',
              id: 'pluginlet:probe',
              order: 500,
            }, SessionProbe)),
        )
        // The permission manager lives where plugin configuration lives: the
        // row's page in the sidebar's Plugins panel, keyed
        // `<package>#<row id>` exactly as the patch declares the row.
        seat(
          'pluginlet: permission page',
          () => ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({
              name: 'plugins.row.config',
              key: 'dsh-pluginlet#pluginlet',
              locale: NS,
            }, PermissionsPage)),
        )
        seat('pluginlet: tab lifetime', () => () => {
          syncSeq += 1
          disposeTabs()
        })
      },
    }
  },
})
