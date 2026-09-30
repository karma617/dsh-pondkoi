window.__ModuleLoader__.load({
  id: 'dsh-pondkoi',
  factory: () => {
    const module = { exports: {} }

    /** Client services this half consumes. */
    const inject = ['remotes', 'sessions']

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
        this.shadow = null
        this.bridge = null
        this.destroyed = false
      }

      mount() {
        if (this.overlay || this.destroyed) return
        const overlay = document.createElement('div')
        overlay.id = 'dsh-pondkoi-overlay'
        Object.assign(overlay.style, {
          position: 'fixed', inset: '0', zIndex: '2147483000',
          display: 'none', background: '#102d2c',
        })
        overlay.addEventListener('click', event => {
          // Clicks outside the pond chrome belong to the conversation beneath.
          if (event.target === overlay) this.close()
        })
        const shadow = overlay.attachShadow({ mode: 'open' })
        const style = document.createElement('link')
        style.rel = 'stylesheet'
        style.href = POND_BASE + '/assets/koi-pond.css'
        shadow.append(style)

        const host = document.createElement('div')
        host.className = 'pond-root'
        shadow.append(host)

        const main = document.createElement('main')
        main.setAttribute('part', 'pond')
        host.append(main)

        const canvas = document.createElement('canvas')
        canvas.id = 'pond'
        canvas.tabIndex = 0
        canvas.setAttribute('aria-label', '锦鲤池塘：点击水面投喂，方向键移动投喂点，空格投喂')
        main.append(canvas)

        const running = document.createElement('section')
        running.id = 'running-sessions'
        running.className = 'running-sessions'
        running.setAttribute('aria-live', 'polite')
        running.setAttribute('aria-label', '正在执行的会话')
        running.hidden = true
        running.innerHTML = '<p class="eyebrow">正在执行 <span id="running-count">0</span></p><div id="running-list"></div>'
        main.append(running)

        const header = document.createElement('header')
        header.innerHTML = '<div class="seal" aria-hidden="true">庭</div>'
          + '<div><p class="eyebrow">A LITTLE GARDEN. BETWEEN TASKS</p>'
          + '<h1>后院鱼塘<span>一池清鲤，日月生长。</span></h1></div>'
        const tools = document.createElement('nav')
        tools.className = 'window-tools'
        tools.setAttribute('aria-label', '庭院视图')
        const weather = document.createElement('select')
        weather.id = 'weather-select'
        weather.title = '天气设置'
        weather.setAttribute('aria-label', '天气设置')
        for (const [value, label] of [
          ['auto', '实时天气 (Open-Meteo)'], ['clear', '手动 · 晴天'], ['overcast', '手动 · 阴天'],
          ['drizzle', '手动 · 小雨'], ['rain', '手动 · 中雨'], ['storm', '手动 · 暴雨'],
          ['light_snow', '手动 · 小雪'], ['snow', '手动 · 中雪'], ['heavy_snow', '手动 · 大雪'],
        ]) weather.append(new Option(label, value))
        const light = document.createElement('select')
        light.id = 'light'
        light.title = '时段设置'
        light.setAttribute('aria-label', '时段设置')
        for (const [value, label] of [
          ['auto', '自动时段'], ['dawn', '手动 · 清晨'], ['day', '手动 · 日间'],
          ['dusk', '手动 · 傍晚'], ['night', '手动 · 夜间'],
        ]) light.append(new Option(label, value))
        const zen = document.createElement('button')
        zen.id = 'zen'
        zen.textContent = '禅'
        zen.title = '禅模式：单击鼠标右键退出'
        zen.setAttribute('aria-pressed', 'false')
        tools.append(weather, light, zen)
        header.append(tools)
        main.append(header)

        const aside = document.createElement('aside')
        aside.innerHTML = '<p class="eyebrow">池中住客 <span id="count">–</span></p>'
          + '<h2>与你一起慢慢长大</h2>'
          + '<p id="journey">正在读取庭院手记…</p>'
          + '<div id="fish-list"></div>'
          + '<div id="profile" hidden>'
          + '<div class="profile-header"><label for="fish-name">给它一个名字</label>'
          + '<button type="button" id="close-profile" title="取消选中" aria-label="取消选中">×</button></div>'
          + '<form id="rename-form"><div class="name-row">'
          + '<input id="fish-name" required maxlength="32" autocomplete="off"><button>保存</button></div></form>'
          + '<p id="lineage"></p></div>'
          + '<p id="eggs"></p>'
          + '<details><summary>继续观望 · 成长周期</summary>'
          + '<p>成功发送一条主会话消息，每条锦鲤升 1 级。失败、历史加载、助手回复与原会话重试不计入。</p>'
          + '<p>满 100 级渐长体型、舒展鳍尾；500 级异性配对产卵，再聊 5 次孵出新鲤。'
          + '每条鱼一生产卵一次，鱼与卵合计最多 16 位。</p>'
          + '<p>点击水面投饵，切换「玩水」轻点水面。投喂、进食与陪玩会增加亲密度，'
          + '也可能遇见花信、蜻蜓、青蛙、流萤或跃水锦鲤。亲密度按本地日期呈现春樱、夏荷、秋枫与冬雪薄雾。'
          + '投喂不升等级，没有死亡惩罚。</p></details>'
        main.append(aside)

        const footer = document.createElement('footer')
        const modeTools = document.createElement('div')
        modeTools.className = 'tools'
        modeTools.setAttribute('aria-label', '互动方式')
        const feed = document.createElement('button')
        feed.id = 'feed'
        feed.className = 'active'
        feed.setAttribute('aria-pressed', 'true')
        feed.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12 8 7l7 1 4-3M3 12l5 5 7-1 4 3M2 12h4m14-4 2-2m-2 10 2 2"/></svg>投喂'
        const ripple = document.createElement('button')
        ripple.id = 'ripple'
        ripple.setAttribute('aria-pressed', 'false')
        ripple.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8q5-5 10 0t10 0M2 12q5-5 10 0t10 0M2 16q5-5 10 0t10 0"/></svg>玩水'
        modeTools.append(feed, ripple)
        const hint = document.createElement('p')
        hint.id = 'hint'
        hint.textContent = '轻点水面，它会游过来。'
        const label = document.createElement('span')
        label.className = 'garden-label'
        label.innerHTML = '<strong id="period-name">日间</strong><i>·</i><b id="season-name">春季</b><i>·</i>'
          + '<b id="weather-name">晴天</b><i>·</i><time id="clock">--:--</time><em>日者是日 · KOI GARDEN</em>'
        footer.append(modeTools, hint, label)
        main.append(footer)

        const notice = document.createElement('p')
        notice.id = 'notice'
        notice.setAttribute('role', 'status')
        notice.setAttribute('aria-live', 'polite')
        main.append(notice)

        document.body.append(overlay)
        this.overlay = overlay
        this.shadow = shadow
        this.bridge = this.createBridge()
        // The renderer reads `window.koiPond` at module scope, so the bridge
        // must exist before its scripts execute. It is removed on destroy so a
        // later activation starts from a clean slate.
        window.koiPond = this.bridge

        const refraction = document.createElement('script')
        refraction.src = POND_BASE + '/assets/koi-pond-refraction.js'
        const script = document.createElement('script')
        script.src = POND_BASE + '/assets/koi-pond.js'
        script.addEventListener('load', () => { void this.sync() }, { once: true })
        // Appending the scripts last guarantees the bridge is already installed.
        shadow.append(refraction, script)
        return overlay
      }

      /**
       * The narrow bridge the renderer script expects, backed by same-origin
       * HTTP instead of Electron IPC. The shape matches the shell preload
       * exactly, so `koi-pond.js` runs unmodified.
       */
      createBridge() {
        const listeners = { visibility: new Set(), state: new Set(), running: new Set() }
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
        const overlay = this.mount()
        overlay.style.display = 'block'
        this.bridge._emit('visibility', true)
        window.dispatchEvent(new Event('resize'))
        void this.sync()
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
        this.shadow = null
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
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('viewBox', '0 0 64 64')
      icon.setAttribute('width', '100%')
      icon.setAttribute('height', '100%')
      icon.innerHTML = '<circle cx="32" cy="32" r="30" fill="#0d3733" stroke="#c8b273" stroke-width="2"/>'
        + '<path d="M18 40c6-10 16-12 24-6-4 8-14 12-24 6z" fill="#f3ece0"/>'
        + '<path d="M42 34c4-4 8-3 10 0-3 3-7 4-10 0z" fill="#e07a4f"/>'
        + '<circle cx="27" cy="33" r="1.6" fill="#12332f"/>'
      button.append(icon)
      shadow.append(button, label)

      let dragging = false
      let moved = false
      let originX = 0
      let originY = 0
      let startLeft = start.x
      let startTop = start.y

      const setLabel = text => { label.textContent = text; button.title = text; button.setAttribute('aria-label', text) }
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
