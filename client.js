window.__ModuleLoader__.load({
  id: 'dsh-pondkoi',
  factory: () => {
    const module = { exports: {} }

    /** Client services this half consumes. */
    const inject = ['remote', 'sessions']

    const POND_BASE = '/plugins/dsh-pondkoi'
    const STORAGE_BONDS = 'dsh-pondkoi-bonds'
    const STORAGE_POSITION = 'dsh-pondkoi-toggle-position'
    const TOGGLE_ID = 'dsh-pondkoi-toggle'

    /**
     * Local relationship record (亲密度). Kept in this origin's
     * localStorage, separate from the host-owned level/breeding ledger, exactly
     * as the shell build kept it in a dedicated partition.
     */
    function loadBonds() {
      const empty = { dialogues: null, fish: {} }
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_BONDS) || 'null')
        if (saved && (saved.dialogues === null
          || (Number.isSafeInteger(saved.dialogues) && saved.dialogues >= 0))
          && saved.fish && typeof saved.fish === 'object' && !Array.isArray(saved.fish)) {
          return { dialogues: saved.dialogues ?? 0, fish: saved.fish }
        }
      } catch { /* A damaged local record starts empty and never blocks the pond. */ }
      return empty
    }

    function saveBonds(bonds) {
      try { localStorage.setItem(STORAGE_BONDS, JSON.stringify(bonds)) } catch { /* Optional cache only. */ }
    }

    function request(path, init) {
      return fetch(POND_BASE + path, {
        ...init,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(init && init.headers) },
      }).then(async response => {
        const text = await response.text()
        const body = text === '' ? {} : JSON.parse(text)
        if (!response.ok || body.ok !== true) {
          throw new Error(body.error && body.error.message ? body.error.message : 'pond request failed: ' + response.status)
        }
        return body.value
      })
    }

    /**
     * The canvas garden, mounted in-page instead of in a separate Electron
     * view. The shell build owned this with a WebContentsView plus an IPC
     * preload; a DSH plugin has neither, so the garden is an overlay appended
     * to the host document and talks to the host over same-origin HTTP.
     */
    class PondView {
      constructor(toggle) {
        this.toggle = toggle
        this.overlay = null
        this.frame = null
        this.bridge = null
        this.destroyed = false
      }

      /**
       * Mount the pond in a same-origin iframe.
       *
       * The shell build rendered the garden in its own Electron WebContentsView,
       * so the renderer always had a document of its own. A shadow root cannot
       * substitute: the renderer resolves every element with
       * `document.getElementById`, which never crosses a shadow boundary, so
       * `$('pond')` returned null and the canvas was never painted. An iframe
       * restores that separate-document invariant and `pond.html` loads the same
       * stylesheet and asset URLs relative to the plugin route.
       *
       * The scripts are injected here, after the bridge is installed, so the
       * renderer's `window.koiPond` read at module scope is always satisfied.
       */
      mount() {
        // Idempotent: a second open must return the live overlay rather than
        // undefined, which the caller would read as a mount failure.
        if (this.destroyed) return undefined
        if (this.overlay) return this.overlay
        const overlay = document.createElement('div')
        overlay.id = 'dsh-pondkoi-overlay'
        Object.assign(overlay.style, {
          position: 'fixed', inset: '0', zIndex: '2147483000',
          display: 'none', background: '#102d2c',
        })
        const frame = document.createElement('iframe')
        frame.id = 'dsh-pondkoi-frame'
        frame.title = '后院鱼塘'
        Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' })
        overlay.append(frame)

        this.bridge = this.createBridge()
        const bridge = this.bridge
        frame.addEventListener('load', () => {
          if (this.destroyed) return
          let win
          try {
            win = frame.contentWindow
            // Same-origin by construction; if the browser ever blocks the
            // document the pond must report that instead of silently blanking.
            if (!win || !frame.contentDocument) throw new Error('鱼塘 iframe 无法访问文档')
          } catch (error) {
            console.warn('dsh-pondkoi: 鱼塘 iframe 不可用', error)
            this.reportFrameFailure()
            return
          }
          win.koiPond = bridge
          const doc = frame.contentDocument
          for (const src of [POND_BASE + '/assets/koi-pond-refraction.js', POND_BASE + '/assets/koi-pond.js']) {
            const el = doc.createElement('script')
            el.src = src
            doc.body.append(el)
            if (src.endsWith('koi-pond.js')) el.addEventListener('load', () => { void this.sync() }, { once: true })
          }
          bridge._emit('visibility', true)
          void this.sync()
        }, { once: true })

        frame.src = POND_BASE + '/assets/pond.html'
        document.body.append(overlay)
        this.overlay = overlay
        this.frame = frame
        return overlay
      }

      /** Surface a blocked-iframe failure in the parent, where it is visible. */
      reportFrameFailure() {
        const message = document.createElement('p')
        message.textContent = '鱼塘无法在此窗口中显示：内嵌页面被浏览器策略阻止。'
        Object.assign(message.style, {
          position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
          color: '#f1ebc6', font: '14px system-ui', background: '#123e35', padding: '16px 24px',
          borderRadius: '8px', border: '1px solid #c5b777',
        })
        this.overlay?.append(message)
      }

      /**
       * The narrow bridge the renderer script expects, backed by same-origin
       * HTTP instead of Electron IPC. The shape matches the shell preload
       * exactly, so `koi-pond.js` runs unmodified.
       */
      createBridge() {
        const listeners = { visibility: new Set(), state: new Set(), running: new Set() }

        // One bad listener must not stop the rest from being notified.
        const emit = (key, value) => {
          for (const listener of [...listeners[key]]) {
            try { listener(value) } catch (error) { console.warn('dsh-pondkoi: listener failed', error) }
          }
        }
        return {
          // The renderer chains `.catch()` onto close(), so it must be thenable.
          close: () => { this.close(); return Promise.resolve() },
          getState: () => request('/state'),
          rename: (id, name) => request('/rename', { method: 'POST', body: JSON.stringify({ id, name }) }),
          getLiveWeather: () => request('/weather'),
          onVisibility: listener => { listeners.visibility.add(listener); return () => listeners.visibility.delete(listener) },
          onState: listener => { listeners.state.add(listener); return () => listeners.state.delete(listener) },
          onRunningSessions: listener => { listeners.running.add(listener); return () => listeners.running.delete(listener) },
          _emit: emit,
        }
      }

      async sync() {
        if (this.destroyed) return
        try {
          const state = await this.bridge.getState()
          if (!this.destroyed) this.bridge._emit('state', state)
        } catch (error) {
          console.warn('dsh-pondkoi: 无法读取鱼塘状态', error)
        }
      }

      open() {
        if (this.destroyed) return
        // mount() can fail; surface that instead of dereferencing an undefined overlay.
        const overlay = this.mount()
        if (!overlay) return
        overlay.style.display = 'block'
        // A frame that is already loaded does not fire `load` again, so publish
        // visibility here as well as from the load handler.
        this.bridge._emit('visibility', true)
        const doc = this.frame?.contentDocument
        if (doc && doc.readyState === 'complete') void this.sync()
      }

      close() {
        if (!this.overlay || this.overlay.style.display === 'none') return
        this.overlay.style.display = 'none'
        this.bridge._emit('visibility', false)
        this.syncBonds()
      }

      get open_() { return Boolean(this.overlay) && this.overlay.style.display !== 'none' }

      /**
       * The shell build let the renderer flush its own bond record on hide. The
       * record lives in this origin's localStorage, so the client half reads it
       * back after the renderer has written it and mirrors the dialogue count.
       */
      syncBonds() {
        const bonds = loadBonds()
        if (bonds.dialogues === null) return
        saveBonds(bonds)
      }

      destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.overlay?.remove()
        this.overlay = null
        this.frame = null
        if (window.koiPond === this.bridge) window.koiPond = undefined
        this.bridge = null
      }
    }

    /**
     * The floating 「池」ball. The shell build installed it from the Electron
     * preload into the chat page; a client plugin installs it from inside the
     * page itself, so it lives and dies with the plugin fiber.
     */
    function installToggle(onToggle) {
      if (document.getElementById(TOGGLE_ID)) return () => {}
      const host = document.createElement('div')
      host.id = TOGGLE_ID
      const size = 56
      const margin = 12

      let saved = null
      try {
        const raw = localStorage.getItem(STORAGE_POSITION)
        const parsed = raw ? JSON.parse(raw) : null
        if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number'
          && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) saved = parsed
      } catch { /* An invalid position falls back to the corner. */ }

      const clamp = (left, top) => {
        const maxX = Math.max(margin, (window.innerWidth || document.documentElement.clientWidth) - size - margin)
        const maxY = Math.max(margin, (window.innerHeight || document.documentElement.clientHeight) - size - margin)
        return { x: Math.min(Math.max(margin, left), maxX), y: Math.min(Math.max(margin, top), maxY) }
      }

      const width = window.innerWidth || document.documentElement.clientWidth || 800
      const height = window.innerHeight || document.documentElement.clientHeight || 600
      const start = saved && saved.left >= 0 && saved.left <= width - size && saved.top >= 0 && saved.top <= height - size
        ? clamp(saved.left, saved.top)
        : clamp(width - size - 16, height - size - 16)

      Object.assign(host.style, {
        position: 'fixed', left: start.x + 'px', top: start.y + 'px',
        width: size + 'px', height: size + 'px', zIndex: '2147483647',
        userSelect: 'none', webkitUserSelect: 'none', touchAction: 'none',
      })

      const shadow = host.attachShadow({ mode: 'open' })
      const style = new CSSStyleSheet()
      // Inline SVG keeps the ball self-contained: no extra request, no asset route.
      style.replaceSync(`
        :host { display: block; }
        button {
          width: 100%; height: 100%; box-sizing: border-box; border: none; padding: 0;
          background-color: transparent; background-repeat: no-repeat;
          background-position: center; background-size: contain;
          filter: drop-shadow(0 4px 10px rgba(0,0,0,.25));
          cursor: grab; -webkit-app-region: no-drag; outline: none;
          transition: transform .15s ease, filter .15s ease;
        }
        button:hover { transform: scale(1.12); filter: drop-shadow(0 6px 14px rgba(0,0,0,.35)); }
        button:active { cursor: grabbing; transform: scale(.96); }
        button:focus-visible { filter: drop-shadow(0 0 6px #40877f); }
        button:disabled { opacity: .6; cursor: wait; }
        button img { width: 100%; height: 100%; display: block; object-fit: contain; pointer-events: none; }
        span {
          position: absolute; left: 50%; transform: translateX(-50%); white-space: nowrap;
          font: 12px system-ui; background: #173e39; color: #fff; padding: 6px 10px;
          border-radius: 4px; display: none; pointer-events: none;
          box-shadow: 0 2px 6px rgba(0,0,0,.2); z-index: 1;
        }
        :host([data-placement="top"]) span { top: auto; bottom: calc(100% + 8px); }
        :host(:not([data-placement="top"])) span { top: calc(100% + 8px); bottom: auto; }
        button:hover + span, button:focus-visible + span { display: block; }
      `)
      shadow.adoptedStyleSheets = [style]

      const button = document.createElement('button')
      button.type = 'button'
      const label = document.createElement('span')
      // The toggle uses the shipped lotus artwork. The shell build inlined the
      // same bitmap as a base64 data URI; over HTTP the plugin serves it from
      // its asset route instead, with a 2x source for high-DPI displays.
      const icon = document.createElement('img')
      icon.alt = ''
      icon.draggable = false
      icon.decoding = 'async'
      icon.src = POND_BASE + '/assets/koi-pond-toggle.png'
      icon.srcset = POND_BASE + '/assets/koi-pond-toggle.png 1x, ' + POND_BASE + '/assets/koi-pond-toggle@2x.png 2x'
      button.append(icon)
      shadow.append(button, label)

      let dragging = false
      let moved = false
      let originX = 0
      let originY = 0
      let startLeft = start.x
      let startTop = start.y

      const setLabel = text => { label.textContent = text; button.title = text; button.setAttribute('aria-label', text) }
      setLabel('后院鱼塘')
      const placement = top => {
        host.setAttribute('data-placement', (window.innerHeight || 600) - (top + size) < 48 ? 'top' : 'bottom')
      }
      placement(start.y)

      button.addEventListener('pointerdown', event => {
        if (event.button !== 0) return
        dragging = true
        moved = false
        originX = event.clientX
        originY = event.clientY
        startLeft = host.offsetLeft
        startTop = host.offsetTop
        button.setPointerCapture(event.pointerId)
      })
      button.addEventListener('pointermove', event => {
        if (!dragging) return
        const dx = event.clientX - originX
        const dy = event.clientY - originY
        if (!moved && Math.hypot(dx, dy) > 4) { moved = true; label.style.display = 'none' }
        if (moved) {
          const next = clamp(startLeft + dx, startTop + dy)
          host.style.left = next.x + 'px'
          host.style.top = next.y + 'px'
          placement(next.y)
        }
      })
      const release = event => {
        if (!dragging) return
        dragging = false
        try { if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId) } catch { /* already released */ }
        if (moved) {
          try { localStorage.setItem(STORAGE_POSITION, JSON.stringify({ left: host.offsetLeft, top: host.offsetTop })) } catch { /* optional */ }
          setTimeout(() => { label.style.display = '' }, 100)
        }
      }
      button.addEventListener('pointerup', release)
      button.addEventListener('pointercancel', release)
      button.addEventListener('click', event => {
        if (moved) { event.preventDefault(); event.stopPropagation(); moved = false; return }
        void onToggle()
      })

      const onResize = () => {
        const next = clamp(host.offsetLeft, host.offsetTop)
        host.style.left = next.x + 'px'
        host.style.top = next.y + 'px'
        placement(next.y)
      }
      window.addEventListener('resize', onResize)
      document.body.append(host)

      return () => {
        window.removeEventListener('resize', onResize)
        host.remove()
      }
    }

    function apply(ctx) {
      const view = new PondView()
      const removeToggle = installToggle(() => {
        if (view.open_) view.close()
        else view.open()
      })

      // Escape returns to the conversation from anywhere in the garden.
      const onKey = event => {
        if (event.key === 'Escape' && view.open_) {
          event.preventDefault()
          view.close()
        }
      }
      window.addEventListener('keydown', onKey)

      /**
       * Growth observation. The shell build wrapped the chat module's `prompt`
       * method through an Electron module-factory transform. A client plugin
       * already lives inside the page's module graph, so it reads the public
       * session surface instead: a strictly increasing user-message count for
       * the main session is the send signal, and sub-agent sessions are skipped
       * the same way the shell skipped `address !== undefined`.
       */
      const observe = () => {
        const sessions = ctx.sessions
        if (!sessions || typeof sessions.list?.subscribe !== 'function') return () => {}
        const seen = new Map()
        return sessions.list.subscribe(snapshot => {
          try {
            const current = snapshot && snapshot.current
            if (typeof current !== 'string') return
            const entry = snapshot.byId && snapshot.byId[current]
            if (!entry) return
            const messages = Array.isArray(entry.messages) ? entry.messages : []
            let userCount = 0
            for (const message of messages) {
              if (message && (message.role === 'user' || message.author === 'user')) userCount++
            }
            const previous = seen.get(current)
            seen.set(current, userCount)
            if (previous === undefined || userCount <= previous) return
            void request('/dialogue', {
              method: 'POST',
              body: JSON.stringify({ sessionId: current, requestId: String(userCount) }),
            }).catch(error => console.warn('dsh-pondkoi: 成长记录未送达，聊天发送结果保持不变', error))
          } catch (error) {
            console.warn('dsh-pondkoi: 成长观察跳过一轮更新', error)
          }
        })
      }

      let unobserve = () => {}
      try {
        unobserve = observe()
      } catch (error) {
        console.warn('dsh-pondkoi: 成长观察不可用，鱼塘仍可投喂', error)
      }

      ctx.effect(() => () => {
        unobserve()
        window.removeEventListener('keydown', onKey)
        removeToggle()
        view.destroy()
      }, 'dsh-pondkoi: client teardown')
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
