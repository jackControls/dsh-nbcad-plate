/**
 * Browser half of dsh-nbcad-plate: the "2D → 3D" panel in the dsh Web UI.
 *
 * Hand-written in the closure-factory shape the dsh client module loader expects, so the
 * package needs no build step: `require` answers the frozen platform table (React), and
 * the UI is plain React element calls.
 *
 * The panel lets a user pick one print (PDF, PNG or JPG), sends it to the host half, starts a
 * session in the chosen workspace with the plate workflow prompt, follows that session, and
 * offers every STEP file the run produces for saving. It also shows, refreshed every two
 * seconds, whether the noBS CAD engine is reachable and whether a noBS CAD desktop is running
 * (from the desktop's heartbeat registry, see lib/index.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-nbcad-plate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'nbcad-2d-3d'
    const API = '/dsh-nbcad/api'
    const STATUS_INTERVAL_MS = 2000
    const OUTPUT_INTERVAL_MS = 3000
    const JOBS_KEY = 'dsh-nbcad-plate.jobs'
    const NS = 'nbcadPlate'
    const inject = ['slots', 'sessions', 'workspaces', 'locale', 'layout']

    // ── dictionaries: the UI follows dsh's global language setting (Settings → General) ──
    const en = {
      'panel.label': '2D → 3D',
      'panel.intro': 'Turn one engineering print of a flat plate part into a STEP file with noBS CAD. The model reads the print, writes the noBS CAD script, checks the result against the drawing and exports STEP; you save it where you want.',
      'status.checking': 'checking noBS CAD…',
      'status.unavailable': 'status unavailable: {error}',
      'status.engine.ready': 'noBS CAD engine ready',
      'status.engine.missing': 'noBS CAD engine not found',
      'status.engine.hint': 'set config.server or NBCAD_MCP (looked for "{configured}")',
      'status.desktop.running': 'noBS CAD desktop running: {n} document(s)',
      'status.desktop.notRunning': 'noBS CAD desktop not running',
      'status.desktop.lastBeat': 'last heartbeat {age}',
      'status.desktop.noBeat': 'no heartbeat within {s} s',
      'status.desktop.noRegistry': 'no session registry yet',
      'status.probe.ready': 'print probe ready ({platform})',
      'status.probe.missing': 'no print probe binary for {platform}',
      'status.probe.hint': 'set config.probe to a print-probe build for this machine',
      'status.checked': 'checked {age} · every {every} s',
      'status.refresh': 'refresh',
      'form.workspace': 'Workspace',
      'form.noWorkspace': 'no workspace yet: add one in the sidebar',
      'form.print': 'Print (one PDF, PNG or JPG)',
      'form.localPath': 'or a file already on this machine',
      'form.localPathPlaceholder': '/absolute/path/to/print.pdf',
      'form.part': 'Part name (file stem of the outputs)',
      'form.notes': 'Notes for the model (optional)',
      'form.notesPlaceholder': 'e.g. the plate is 241 × 40 × 11.5; treat the 27 deep callout as a print error',
      'action.convert': 'Convert to STEP',
      'action.starting': 'Starting…',
      'action.needEngine': 'the engine and the print probe must be ready first',
      'action.outputsTo': 'outputs go to {dir}/out/',
      'jobs.title': 'Conversions',
      'job.state.converting': 'converting',
      'job.state.done': 'done',
      'job.state.idle': 'idle',
      'job.state.missing': 'session not listed',
      'job.started': 'started {age}',
      'job.open': 'Open conversation',
      'job.remove': 'remove',
      'job.removeTitle': 'Forget this job (files stay in the workspace)',
      'job.noStep': 'No STEP file yet. Open the conversation to see what the model is doing or answer a question.',
      'job.noSession': 'The session is no longer listed.',
      'job.working': 'The model is reading the print and building the part; this takes 5 to 30 minutes depending on the drawing.',
      'job.saveStep': 'Save STEP as…',
      'job.saveReport': 'Save report…',
      'job.saved': 'saved',
      'job.downloaded': 'downloaded',
      'job.cancelled': 'cancelled',
      'time.sAgo': '{n} s ago',
      'time.minAgo': '{n} min ago',
      'time.hAgo': '{n} h ago',
      'error.notAddressable': 'the new session did not become addressable; open it and paste the brief yourself',
      'brief.language': '',
    }
    const zh = {
      'panel.label': '2D → 3D',
      'panel.intro': '把一张平板零件的工程图纸转换成 STEP 文件。模型读图、编写 noBS CAD 脚本、对照图纸核对结果并导出 STEP；你选择保存位置。',
      'status.checking': '正在检查 noBS CAD…',
      'status.unavailable': '状态不可用：{error}',
      'status.engine.ready': 'noBS CAD 引擎已就绪',
      'status.engine.missing': '未找到 noBS CAD 引擎',
      'status.engine.hint': '请设置 config.server 或 NBCAD_MCP（查找的是 "{configured}"）',
      'status.desktop.running': 'noBS CAD 桌面版运行中：{n} 个文档',
      'status.desktop.notRunning': 'noBS CAD 桌面版未运行',
      'status.desktop.lastBeat': '最近心跳 {age}',
      'status.desktop.noBeat': '{s} 秒内没有心跳',
      'status.desktop.noRegistry': '尚无会话注册表',
      'status.probe.ready': '图纸探测器就绪（{platform}）',
      'status.probe.missing': '没有适用于 {platform} 的图纸探测器',
      'status.probe.hint': '请把 config.probe 指向本机可用的 print-probe 构建',
      'status.checked': '{age}检查 · 每 {every} 秒一次',
      'status.refresh': '刷新',
      'form.workspace': '工作区',
      'form.noWorkspace': '还没有工作区：请在侧边栏添加',
      'form.print': '图纸（一张 PDF、PNG 或 JPG）',
      'form.localPath': '或本机上已有的文件',
      'form.localPathPlaceholder': '/图纸/的/绝对路径.pdf',
      'form.part': '零件名（输出文件的主名）',
      'form.notes': '给模型的说明（可选）',
      'form.notesPlaceholder': '例如：板厚 241 × 40 × 11.5；深 27 的标注按图纸笔误处理',
      'action.convert': '转换为 STEP',
      'action.starting': '正在启动…',
      'action.needEngine': '需要引擎和图纸探测器都就绪',
      'action.outputsTo': '输出保存到 {dir}/out/',
      'jobs.title': '转换任务',
      'job.state.converting': '转换中',
      'job.state.done': '已完成',
      'job.state.idle': '空闲',
      'job.state.missing': '会话已不在列表中',
      'job.started': '开始于 {age}',
      'job.open': '打开对话',
      'job.remove': '移除',
      'job.removeTitle': '忘记这个任务（文件仍保留在工作区）',
      'job.noStep': '还没有 STEP 文件。打开对话查看模型在做什么，或回答它的提问。',
      'job.noSession': '该会话已不在列表中。',
      'job.working': '模型正在读图并建模；视图纸复杂程度需要 5 到 30 分钟。',
      'job.saveStep': 'STEP 另存为…',
      'job.saveReport': '报告另存为…',
      'job.saved': '已保存',
      'job.downloaded': '已下载',
      'job.cancelled': '已取消',
      'time.sAgo': '{n} 秒前',
      'time.minAgo': '{n} 分钟前',
      'time.hAgo': '{n} 小时前',
      'error.notAddressable': '新会话未能就绪；请打开它并自行粘贴任务说明',
      'brief.language': '对话回复和 report.md 请使用中文；脚本、文件名和特征表中的字段名保持英文。',
    }
    /** Translate through dsh's locale service (it fills {name} params); falls back to English. */
    function tr(t, key, vars) {
      let text = t ? t(key, vars) : undefined
      if (typeof text !== 'string' || text === key) text = en[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v))
      return text
    }
    /** Re-render the caller whenever dsh's active language (or a dictionary) changes. */
    function useLocaleRevision(ctx) {
      const locale = ctx.locale
      const subscribe = React.useCallback((listener) => locale.subscribe(listener), [locale])
      const get = React.useCallback(() => (locale.getSnapshot ? locale.getSnapshot() : locale.getLocale()), [locale])
      const snapshot = React.useSyncExternalStore(subscribe, get, get)
      return snapshot?.revision ?? snapshot?.active ?? ''
    }

    // ── tiny store ────────────────────────────────────────────────────────────
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => { value = typeof next === 'function' ? next(value) : next; for (const l of listeners) l() },
        subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
      }
    }
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get)
    }
    /** Read any dsh snapshot store (getSnapshot or get) without caring which it is. */
    function snapshotOf(store) {
      try { return store?.getSnapshot?.() ?? store?.get?.() ?? null } catch { return null }
    }
    function useDshStore(store) {
      const subscribe = React.useCallback((l) => (store?.subscribe ? store.subscribe(l) : () => {}), [store])
      const get = React.useCallback(() => snapshotOf(store), [store])
      return React.useSyncExternalStore(subscribe, get)
    }

    // ── persisted jobs ────────────────────────────────────────────────────────
    function loadJobs() {
      try { const raw = localStorage.getItem(JOBS_KEY); const jobs = raw ? JSON.parse(raw) : []; return Array.isArray(jobs) ? jobs : [] } catch { return [] }
    }
    const jobs = createStore(loadJobs())
    function saveJobs(next) {
      jobs.set(next)
      try { localStorage.setItem(JOBS_KEY, JSON.stringify(next.slice(0, 20))) } catch {}
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    function partNameFrom(fileName) {
      const stem = String(fileName || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      return stem || 'part'
    }
    function brief(job, notes, languageLine) {
      const source = job.printPath
      const raster = ''
      return [
        'Load the `nbcad-plate` skill first and follow it exactly; it gives the workflow, the modelling idioms, an example script and the CAD and print tools.',
        '',
        `Turn the 2D engineering print at ${source} into a 3D solid with noBS CAD, working in this directory. Millimetres throughout.${raster}`,
        '',
        'Deliverables, all in out/:',
        `1. out/${job.part}-features.md: the complete callout inventory (every callout group with an id, count, diameter, style, depth, face), the outline and thickness, then every hole position with the chain arithmetic and checks, and the sum of the counts.`,
        `2. out/${job.part}.nbcad.jsonc: the script, and out/${job.part}.step exported by nbcad_run_script.`,
        `3. out/${job.part}-report.md: what was modelled per group, what was left out (fillets, chamfers, edge breaks, finish, tolerances) and every uncertain reading with the alternatives you considered.`,
        '',
        'Requirements: every callout group on the sheet is modelled. Several script runs are allowed: run, fix, re-run, and verify with the probe and the overlay as the skill says before finishing. A group whose position you cannot resolve is still modelled at your best estimate and marked UNCERTAIN in the report; do not skip it.',
        notes ? `\nNotes from the user: ${notes}` : '',
        languageLine ? `\n${languageLine}` : '',
      ].join('\n')
    }
    async function api(path, init) {
      const response = await fetch(API + path, init)
      const value = await response.json().catch(() => ({ ok: false, error: `${response.status} ${response.statusText}` }))
      if (!response.ok || value.ok === false) throw new Error(value.error || `${response.status} ${response.statusText}`)
      return value
    }
    function ago(t, ms) {
      if (ms == null) return ''
      const s = Math.round(ms / 1000)
      return s < 60 ? tr(t, 'time.sAgo', { n: s }) : s < 3600 ? tr(t, 'time.minAgo', { n: Math.round(s / 60) }) : tr(t, 'time.hAgo', { n: Math.round(s / 3600) })
    }
    function fmtBytes(n) {
      return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
    }
    async function saveAs(job, file) {
      const url = `${API}/file?dir=${encodeURIComponent(job.workspacePath)}&path=${encodeURIComponent(file.path)}`
      const response = await fetch(url)
      if (!response.ok) throw new Error(`download failed: ${response.status}`)
      const blob = await response.blob()
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: file.name, types: file.kind === 'step' ? [{ description: 'STEP file', accept: { 'application/step': ['.step', '.stp'] } }] : undefined })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          return 'job.saved'
        } catch (error) {
          if (error?.name === 'AbortError') return 'job.cancelled'
          // fall through to the download path
        }
      }
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
      return 'job.downloaded'
    }

    // ── status polling (the "is nbcad running" strip) ─────────────────────────
    const status = createStore({ loading: true, value: null, error: null })
    let statusTimer = null
    let statusWatchers = 0
    async function refreshStatus() {
      try {
        const value = await api('/status')
        status.set({ loading: false, value, error: null })
      } catch (error) {
        status.set((s) => ({ loading: false, value: s.value, error: String(error?.message || error) }))
      }
    }
    function watchStatus() {
      statusWatchers += 1
      if (statusWatchers === 1) {
        void refreshStatus()
        statusTimer = window.setInterval(() => { void refreshStatus() }, STATUS_INTERVAL_MS)
      }
      return () => {
        statusWatchers -= 1
        if (statusWatchers === 0 && statusTimer) { window.clearInterval(statusTimer); statusTimer = null }
      }
    }
    function useStatus() {
      React.useEffect(() => watchStatus(), [])
      return useStore(status)
    }

    // ── components ────────────────────────────────────────────────────────────
    function Dot({ state }) {
      return h('span', { className: `nbcad-dot nbcad-dot-${state}`, 'aria-hidden': 'true' })
    }
    function StatusStrip({ t }) {
      const s = useStatus()
      const v = s.value
      if (!v) return h('div', { className: 'nbcad-status' }, h('span', { className: 'nbcad-muted' }, s.error ? tr(t, 'status.unavailable', { error: s.error }) : tr(t, 'status.checking')))
      const desktop = v.desktop
      const beat = desktop.sessions[0]
      return h('div', { className: 'nbcad-status' },
        h('div', { className: 'nbcad-status-row' },
          h(Dot, { state: v.engine.ready ? 'ok' : 'bad' }),
          h('span', null, tr(t, v.engine.ready ? 'status.engine.ready' : 'status.engine.missing')),
          h('span', { className: 'nbcad-muted' }, v.engine.ready ? v.engine.path : tr(t, 'status.engine.hint', { configured: v.engine.configured }))),
        h('div', { className: 'nbcad-status-row' },
          h(Dot, { state: desktop.running ? 'ok' : 'idle' }),
          h('span', null, desktop.running ? tr(t, 'status.desktop.running', { n: desktop.sessions.length }) : tr(t, 'status.desktop.notRunning')),
          h('span', { className: 'nbcad-muted' }, desktop.running ? tr(t, 'status.desktop.lastBeat', { age: ago(t, beat.ageMs) }) : (desktop.registryPresent ? tr(t, 'status.desktop.noBeat', { s: Math.round(desktop.staleMs / 1000) }) : tr(t, 'status.desktop.noRegistry')))),
        h('div', { className: 'nbcad-status-row' },
          h(Dot, { state: v.probe.ready ? 'ok' : 'bad' }),
          h('span', null, tr(t, v.probe.ready ? 'status.probe.ready' : 'status.probe.missing', { platform: v.probe.platform })),
          h('span', { className: 'nbcad-muted' }, v.probe.ready ? v.probe.path : tr(t, 'status.probe.hint'))),
        h('div', { className: 'nbcad-status-foot nbcad-muted' }, tr(t, 'status.checked', { age: ago(t, Date.now() - v.checkedAt), every: STATUS_INTERVAL_MS / 1000 }), h('button', { className: 'nbcad-link', onClick: () => { void refreshStatus() } }, tr(t, 'status.refresh'))))
    }

    function useWorkspaceItems(ctx) {
      const snapshot = useDshStore(ctx.workspaces?.list)
      const items = Array.isArray(snapshot) ? snapshot : (snapshot?.items ?? snapshot?.workspaces ?? [])
      return items.filter((w) => w && w.workspaceId && w.path)
    }
    function useSessionsSnapshot(ctx) {
      return useDshStore(ctx.sessions?.list) || { current: null, byId: {} }
    }

    function JobCard({ ctx, t, job, onRemove }) {
      const sessions = useSessionsSnapshot(ctx)
      const summary = sessions.byId?.[job.sessionId]
      const running = summary?.running === true
      const [outputs, setOutputs] = React.useState([])
      const [message, setMessage] = React.useState('')
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try { const value = await api(`/outputs?dir=${encodeURIComponent(job.workspacePath)}`); if (alive) setOutputs(value.files) } catch {}
        }
        void load()
        const timer = window.setInterval(load, OUTPUT_INTERVAL_MS)
        return () => { alive = false; window.clearInterval(timer) }
      }, [job.workspacePath])
      const steps = outputs.filter((f) => f.kind === 'step' && f.modifiedAt >= job.startedAt - 1000)
      const reports = outputs.filter((f) => f.kind === 'report' && f.modifiedAt >= job.startedAt - 1000)
      const state = tr(t, running ? 'job.state.converting' : steps.length ? 'job.state.done' : summary ? 'job.state.idle' : 'job.state.missing')
      const save = async (file) => { try { setMessage(`${file.name}: ${tr(t, await saveAs(job, file))}`) } catch (error) { setMessage(String(error?.message || error)) } }
      return h('div', { className: 'nbcad-card' },
        h('div', { className: 'nbcad-card-head' },
          h(Dot, { state: running ? 'busy' : steps.length ? 'ok' : 'idle' }),
          h('strong', null, job.part),
          h('span', { className: 'nbcad-muted' }, `${job.fileName} · ${state} · ${tr(t, 'job.started', { age: ago(t, Date.now() - job.startedAt) })}`),
          h('span', { className: 'nbcad-spacer' }),
          h('button', { className: 'nbcad-btn', onClick: () => { ctx.sessions.open(job.sessionId); ctx.layout.selectPanel(null) } }, tr(t, 'job.open')),
          h('button', { className: 'nbcad-link', onClick: onRemove, title: tr(t, 'job.removeTitle') }, tr(t, 'job.remove'))),
        steps.length === 0 && !running ? h('div', { className: 'nbcad-muted' }, tr(t, summary ? 'job.noStep' : 'job.noSession')) : null,
        running && steps.length === 0 ? h('div', { className: 'nbcad-muted' }, tr(t, 'job.working')) : null,
        steps.map((file) => h('div', { key: file.path, className: 'nbcad-file' },
          h('span', null, file.relative), h('span', { className: 'nbcad-muted' }, `${fmtBytes(file.size)} · ${ago(t, Date.now() - file.modifiedAt)}`),
          h('span', { className: 'nbcad-spacer' }),
          h('button', { className: 'nbcad-btn nbcad-primary', onClick: () => save(file) }, tr(t, 'job.saveStep')))),
        reports.map((file) => h('div', { key: file.path, className: 'nbcad-file' },
          h('span', null, file.relative), h('span', { className: 'nbcad-muted' }, fmtBytes(file.size)),
          h('span', { className: 'nbcad-spacer' }),
          h('button', { className: 'nbcad-btn', onClick: () => save(file) }, tr(t, 'job.saveReport')))),
        message ? h('div', { className: 'nbcad-muted' }, message) : null)
    }

    function Panel({ ctx }) {
      useLocaleRevision(ctx)
      const t = ctx.locale.bind(NS)
      const statusState = useStatus()
      const workspaces = useWorkspaceItems(ctx)
      const sessions = useSessionsSnapshot(ctx)
      const jobList = useStore(jobs)
      const current = sessions.current ? sessions.byId?.[sessions.current] : null
      const currentWorkspace = React.useMemo(() => workspaces.find((w) => current?.cwd && (w.path === current.cwd || current.cwd.startsWith(w.path + '/'))) ?? workspaces[0] ?? null, [workspaces, current?.cwd])
      const [workspaceId, setWorkspaceId] = React.useState(null)
      const chosen = workspaces.find((w) => w.workspaceId === workspaceId) ?? currentWorkspace
      const [file, setFile] = React.useState(null)
      const [localPath, setLocalPath] = React.useState('')
      const [part, setPart] = React.useState('')
      const [notes, setNotes] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const engineReady = statusState.value?.engine?.ready === true
      const source = file ? file.name : localPath.trim() ? localPath.trim() : ''
      const partName = part || partNameFrom(source.split('/').pop())
      const canConvert = !busy && engineReady && chosen && source

      async function convert() {
        setBusy(true); setError('')
        try {
          const dir = chosen.path
          let stored
          if (file) {
            stored = await api(`/print?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
          } else {
            stored = await api(`/local-print?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(localPath.trim())}`, { method: 'POST' })
          }
          const job = { id: `${Date.now()}`, part: partName, fileName: source.split('/').pop(), printPath: stored.path, workspaceId: chosen.workspaceId, workspacePath: dir, startedAt: Date.now(), sessionId: null }
          const sessionId = await ctx.sessions.create({ workspaceId: chosen.workspaceId })
          job.sessionId = sessionId
          ctx.sessions.open(sessionId)
          let session = null
          for (let i = 0; i < 50 && !session?.prompt; i += 1) {
            session = ctx.sessions.binding?.(sessionId)?.session ?? null
            if (!session?.prompt) await new Promise((r) => setTimeout(r, 100))
          }
          if (!session?.prompt) throw new Error(tr(t, 'error.notAddressable'))
          try { await session.rename?.(`2D → 3D: ${partName}`) } catch {}
          await session.prompt([{ type: 'text', text: brief(job, notes.trim(), tr(t, 'brief.language')) }], 'queue')
          saveJobs([job, ...jobs.get()])
          setFile(null); setLocalPath(''); setPart(''); setNotes('')
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'nbcad-panel' },
        h('h1', { className: 'nbcad-title' }, tr(t, 'panel.label')),
        h('p', { className: 'nbcad-muted' }, tr(t, 'panel.intro')),
        h(StatusStrip, { t }),
        h('div', { className: 'nbcad-form' },
          h('label', { className: 'nbcad-field' }, h('span', null, tr(t, 'form.workspace')),
            h('select', { value: chosen?.workspaceId ?? '', onChange: (e) => setWorkspaceId(e.target.value), disabled: workspaces.length === 0 },
              workspaces.length === 0 ? h('option', { value: '' }, tr(t, 'form.noWorkspace')) : null,
              workspaces.map((w) => h('option', { key: w.workspaceId, value: w.workspaceId }, `${w.title || w.path.split('/').pop()}  —  ${w.path}`)))),
          h('label', { className: 'nbcad-field' }, h('span', null, tr(t, 'form.print')),
            h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg', onChange: (e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) setLocalPath('') } })),
          h('label', { className: 'nbcad-field' }, h('span', null, tr(t, 'form.localPath')),
            h('input', { type: 'text', placeholder: tr(t, 'form.localPathPlaceholder'), value: localPath, onChange: (e) => { setLocalPath(e.target.value); if (e.target.value) setFile(null) } })),
          h('label', { className: 'nbcad-field' }, h('span', null, tr(t, 'form.part')),
            h('input', { type: 'text', placeholder: partName, value: part, onChange: (e) => setPart(partNameFrom(e.target.value) === 'part' && !e.target.value ? '' : e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-')) })),
          h('label', { className: 'nbcad-field' }, h('span', null, tr(t, 'form.notes')),
            h('textarea', { rows: 2, placeholder: tr(t, 'form.notesPlaceholder'), value: notes, onChange: (e) => setNotes(e.target.value) })),
          h('div', { className: 'nbcad-actions' },
            h('button', { className: 'nbcad-btn nbcad-primary', disabled: !canConvert, onClick: convert }, tr(t, busy ? 'action.starting' : 'action.convert')),
            !engineReady ? h('span', { className: 'nbcad-muted' }, tr(t, 'action.needEngine')) : chosen ? h('span', { className: 'nbcad-muted' }, tr(t, 'action.outputsTo', { dir: chosen.path })) : null),
          error ? h('div', { className: 'nbcad-error' }, error) : null),
        jobList.length ? h('h2', { className: 'nbcad-subtitle' }, tr(t, 'jobs.title')) : null,
        jobList.map((job) => h(JobCard, { key: job.id, ctx, t, job, onRemove: () => saveJobs(jobs.get().filter((j) => j.id !== job.id)) })))
    }

    function PanelIcon({ size, active }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: active ? 2 : 1.6, strokeLinejoin: 'round', strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 7.5 12 3l9 4.5-9 4.5z' }),
        h('path', { d: 'M3 7.5V16l9 4.5 9-4.5V7.5' }),
        h('path', { d: 'M12 12v8.5' }),
        h('circle', { cx: 7.5, cy: 15.5, r: 1.2 }),
        h('circle', { cx: 16.5, cy: 15.5, r: 1.2 }))
    }

    const STYLE = `
.nbcad-panel{max-width:860px;margin:0 auto;padding:28px 32px 48px;font-size:14px;line-height:1.45}
.nbcad-title{font-size:22px;font-weight:600;margin:0 0 6px}
.nbcad-subtitle{font-size:16px;font-weight:600;margin:28px 0 10px}
.nbcad-muted{opacity:.65;font-size:13px}
.nbcad-status{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:10px 14px;margin:16px 0;display:flex;flex-direction:column;gap:6px}
.nbcad-status-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.nbcad-status-row>span:first-of-type{font-weight:500}
.nbcad-status-foot{display:flex;gap:10px;align-items:center;font-size:12px}
.nbcad-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#9a9a9a;flex:none;position:relative;top:-1px}
.nbcad-dot-ok{background:#2fa84f}.nbcad-dot-bad{background:#d64545}.nbcad-dot-warn{background:#e0a020}.nbcad-dot-idle{background:#9a9a9a}
.nbcad-dot-busy{background:#3b82f6;animation:nbcad-pulse 1.2s ease-in-out infinite}
@keyframes nbcad-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.nbcad-form{display:flex;flex-direction:column;gap:12px;margin-top:8px}
.nbcad-field{display:flex;flex-direction:column;gap:4px}
.nbcad-field>span{font-size:12px;font-weight:500;opacity:.8}
.nbcad-field input[type=text],.nbcad-field select,.nbcad-field textarea{font:inherit;padding:7px 9px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;max-width:640px}
.nbcad-field input[type=file]{font:inherit}
.nbcad-actions{display:flex;gap:12px;align-items:center;margin-top:4px}
.nbcad-btn{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer}
.nbcad-btn:disabled{opacity:.45;cursor:default}
.nbcad-primary{background:#3b82f6;border-color:#3b82f6;color:#fff}
.nbcad-link{font:inherit;font-size:12px;background:none;border:none;color:inherit;opacity:.7;cursor:pointer;text-decoration:underline;padding:0}
.nbcad-error{color:#d64545;font-size:13px}
.nbcad-card{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:12px 14px;margin-bottom:12px;display:flex;flex-direction:column;gap:8px}
.nbcad-card-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.nbcad-file{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px dashed rgba(127,127,127,.3)}
.nbcad-spacer{flex:1}
`

    function apply(ctx) {
      const style = document.createElement('style')
      style.textContent = STYLE
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'nbcad-plate: styles')
      // both shipped locales are registered; the UI follows Settings → General → Language
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'nbcad-plate: dictionaries')
      const label = ctx.locale.bind(NS)
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => label('panel.label'), locale: NS }, PanelIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => h(Panel, { ctx })))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
