import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function normalizeUsagePayload(data) {
  const usage = data && data.usage
  if (!usage || typeof usage !== 'object') throw new Error('unexpected response shape: missing usage')
  const LABELS = { rolling: '5小时', weekly: '本周', monthly: '本月' }
  const windows = []
  for (const id of ['rolling', 'weekly', 'monthly']) {
    const w = usage[id]
    if (!w || typeof w !== 'object') throw new Error('missing usage window: ' + id)
    const p = Number(w.percent)
    if (!isFinite(p)) throw new Error('non-numeric percent in ' + id)
    windows.push({
      id,
      label: LABELS[id],
      percent: Math.max(0, Math.min(100, Math.round(p))),
      status: w.status === 'rate-limited' ? 'rate-limited' : 'ok',
      resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
    })
  }
  return { metric: 'percent-windows', windows }
}

export function hashId(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

export function readJsonFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function readAuthJsonKey(home, entry = 'opencode-go') {
  const data = readJsonFile(path.join(home, '.local', 'share', 'opencode', 'auth.json'))
  const hit = data && data[entry]
  return hit && typeof hit.key === 'string' && hit.key.trim() ? hit.key.trim() : null
}

export function readConfigJsonKey(home, pointer = 'provider.opencodego.options.apiKey') {
  const data = readJsonFile(path.join(home, '.config', 'opencode', 'opencode.json'))
  let cur = data
  for (const seg of pointer.split('.')) {
    if (cur && typeof cur === 'object' && seg in cur) cur = cur[seg]
    else return null
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : null
}

export async function resolveKey(ctx, resolvers) {
  for (const r of resolvers) {
    try {
      const v = await r.resolve(ctx)
      if (typeof v === 'string' && v.trim()) {
        return { key: v.trim().replace(/^Bearer\s+/i, ''), source: r.label }
      }
    } catch {
      /* 尝试下一个解析器 */
    }
  }
  return null
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function fetchJson(url, { headers, timeoutMs = 20000, retries = 1, retryDelayMs = 500 } = {}) {
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      lastErr = err
      if (attempt < retries) { await sleep(retryDelayMs); continue }
      break
    }
    if (res.ok) {
      try {
        return await res.json()
      } catch {
        throw new Error('invalid JSON from ' + url)
      }
    }
    lastErr = new Error('HTTP ' + res.status)
    lastErr.status = res.status
    if (res.status >= 500 && attempt < retries) { await sleep(retryDelayMs); continue }
    break
  }
  throw lastErr || new Error('fetch failed: ' + url)
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}
const CACHE_TTL_MS = 30000
const FETCH_TIMEOUT_MS = 20000

function credentialResolver(name) {
  return {
    label: 'credential',
    resolve: async (ctx) => {
      let c = null
      try { c = await ctx.credentials.resolve(name) } catch { return null }
      return c && c.value ? String(c.value) : null
    },
  }
}

const OPENCODE_GO = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  metric: 'percent-windows',
  keyResolvers: [
    credentialResolver('OPENCODE_GO_KEY'),
    { label: 'auth.json', resolve: () => readAuthJsonKey(os.homedir()) },
    { label: 'config', resolve: () => readConfigJsonKey(os.homedir()) },
  ],
  async fetchUsage(key) {
    const data = await fetchJson('https://opencode.ai/zen/go/v1/usage', {
      headers: { Authorization: 'Bearer ' + key },
      timeoutMs: FETCH_TIMEOUT_MS,
      retries: 1,
    })
    return normalizeUsagePayload(data)
  },
}

const SOURCES = [OPENCODE_GO]

function trunc(s, n) {
  const t = String((s && s.message) || s || '')
  return t.length > n ? t.slice(0, n) + '\u2026' : t
}

const name = 'dsh-opencode-go-widget'
const inject = ['webServer', 'credentials']

function apply(ctx) {
  const runtimes = new Map() // sourceId -> { cache: {at,payload}|null, inflight: Promise|null }
  const iconCache = new Map() // sourceId -> Buffer
  const disposers = []

  function loadIcon(id) {
    if (iconCache.has(id)) return iconCache.get(id)
    try {
      const bytes = fs.readFileSync(path.join(PACKAGE_ROOT, 'assets', 'icons', id + '.svg'))
      iconCache.set(id, bytes)
      return bytes
    } catch {
      return null
    }
  }

  async function getSourceUsage(source, rk) {
    let rt = runtimes.get(source.id)
    if (!rt) { rt = { cache: null, inflight: null }; runtimes.set(source.id, rt) }
    const now = Date.now()
    if (rt.cache && now - rt.cache.at < CACHE_TTL_MS) {
      return { usage: rt.cache.payload, error: null, updatedAt: rt.cache.at }
    }
    if (rt.inflight) return rt.inflight
    const p = (async () => {
      try {
        const usage = await source.fetchUsage(rk.key)
        rt.cache = { at: Date.now(), payload: usage }
        return { usage, error: null, updatedAt: Date.now() }
      } catch (err) {
        const status = err && err.status
        const transient = !(typeof status === 'number' && status >= 400 && status < 500)
        if (transient && rt.cache) {
          return { usage: rt.cache.payload, error: { stale: true, code: 'FETCH', message: trunc(err, 120) }, updatedAt: rt.cache.at }
        }
        return { usage: null, error: { code: 'FETCH', message: trunc(err, 120) }, updatedAt: null }
      } finally {
        rt.inflight = null
      }
    })()
    rt.inflight = p
    return p
  }

  async function buildDashboard() {
    const settled = await Promise.allSettled(SOURCES.map(async (source) => {
      const rk = await resolveKey(ctx, source.keyResolvers)
      if (!rk) {
        return { id: source.id, name: source.name, metric: source.metric, icon: '/usage/icon/' + source.id + '.svg', source: null, usage: null, updatedAt: null, error: { code: 'NO_KEY', message: '未找到该订阅的 API key' } }
      }
      const u = await getSourceUsage(source, rk)
      return { id: source.id, name: source.name, metric: source.metric, icon: '/usage/icon/' + source.id + '.svg', source: rk.source, usage: u.usage, updatedAt: u.updatedAt, error: u.error }
    }))
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      sources: settled.map((s) => (s.status === 'fulfilled' ? s.value : {
        id: 'unknown', name: '未知订阅', metric: 'percent-windows', icon: null, source: null, usage: null, updatedAt: null, error: { code: 'ERROR', message: '内部错误' },
      })),
    }
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/usage/dashboard.json',
    handler: async (req, res) => {
      try {
        const payload = await buildDashboard()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      } catch (err) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: trunc(err, 200) }))
      }
    },
  }))

  for (const source of SOURCES) {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/usage/icon/' + source.id + '.svg',
      handler: (req, res) => {
        try {
          const bytes = loadIcon(source.id)
          if (!bytes) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'icon not found' }))
            return
          }
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: trunc(err, 200) }))
        }
      },
    }))
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/usage/widget.js',
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(WIDGET_JS)
    },
  }))

  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/usage/widget.js') !== -1) return html
    const tag = '<script defer src="/usage/widget.js"></script>'
    return html.indexOf('</body>') !== -1 ? html.replace('</body>', tag + '</body>') : html + tag
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch {}
    }
  })
}

const WIDGET_JS = `(function () {
if (window.__ocUsageWidget) return
window.__ocUsageWidget = true

var DASHBOARD_URL = '/usage/dashboard.json'
var REFRESH_MS = 60000
var TICK_MS = 30000
var FETCH_TIMEOUT_MS = 25000
var ICON_FAILED = {}

var css = [
  '.ocuw-root{position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;flex-direction:column;gap:10px;font-family:inherit;user-select:none;-webkit-user-select:none;color-scheme:light}',
  '.ocuw-card{width:280px;background:rgba(255,255,255,.94);border:1px solid rgba(31,38,82,.28);border-radius:12px;padding:10px 12px;box-shadow:0 6px 18px rgba(0,0,0,.16);cursor:pointer;position:relative;transform-origin:50% 50%;transition:transform .22s cubic-bezier(.34,1.56,.64,1)}',
  '.ocuw-card.ocuw-pressed{transform:scaleY(.94) scaleX(1.03)}',
  '.ocuw-card.ocuw-rate-limited{border-color:rgba(220,38,38,.6)}',
  '.ocuw-badge{position:absolute;top:-7px;right:10px;background:#dc2626;color:#fff;font-size:11px;padding:2px 8px;border-radius:9px;font-weight:600}',
  '.ocuw-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
  '.ocuw-icon{width:20px;height:20px;border-radius:4px;flex:0 0 auto}',
  '.ocuw-initial{width:20px;height:20px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;flex:0 0 auto}',
  '.ocuw-name{font-size:13px;font-weight:700;color:#1f2652;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ocuw-time{font-size:11px;color:#8a93b8;flex:0 0 auto}',
  '.ocuw-row{display:grid;grid-template-columns:52px 1fr 72px;align-items:center;gap:8px;padding:3px 0}',
  '.ocuw-row-label{font-size:12px;color:#5b6390;white-space:nowrap}',
  '.ocuw-bar{height:8px;border-radius:4px;background:rgba(31,38,82,.1);overflow:hidden}',
  '.ocuw-bar-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#34d399,#10b981);transition:width .5s ease}',
  '.ocuw-card.ocuw-rate-limited .ocuw-bar-fill{background:linear-gradient(90deg,#f87171,#dc2626)}',
  '.ocuw-row-right{text-align:right;display:flex;flex-direction:column;gap:1px}',
  '.ocuw-pct{font-size:14px;font-weight:800;color:#1f2652;line-height:1}',
  '.ocuw-reset{font-size:10px;color:#8a93b8;line-height:1}',
  '.ocuw-card.ocuw-rate-limited .ocuw-pct{color:#dc2626}',
  '.ocuw-footer{font-size:11px;color:#b0b6d4;margin-top:6px;border-top:1px dashed rgba(31,38,82,.15);padding-top:5px;line-height:1.4}',
  '.ocuw-msg{width:280px;box-sizing:border-box;background:rgba(255,255,255,.94);border:1px solid rgba(31,38,82,.28);border-radius:12px;padding:12px 14px;color:#8a93b8;font-size:12px;text-align:center;cursor:pointer}'
].join('\\n')

var styleEl = document.createElement('style')
styleEl.textContent = css
document.head.appendChild(styleEl)
var root = document.createElement('div')
root.className = 'ocuw-root'
document.body.appendChild(root)
var state = { data: null }

function pad(n) { return n < 10 ? '0' + n : String(n) }
function formatTime(ms) {
  if (!ms) return '--:--:--'
  var d = new Date(ms)
  if (isNaN(d.getTime())) return '--:--:--'
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}
function formatCountdown(iso, nowMs) {
  if (!iso) return ''
  var t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  var sec = Math.max(0, Math.ceil((t - nowMs) / 1000))
  if (sec === 0) return '即将重置'
  var d = Math.floor(sec / 86400)
  var h = Math.floor((sec % 86400) / 3600)
  var m = Math.floor((sec % 3600) / 60)
  if (d > 0 && h > 0) return d + ' 天 ' + h + ' 小时后重置'
  if (d > 0) return d + ' 天后重置'
  if (h > 0 && m > 0) return h + ' 小时 ' + m + ' 分钟后重置'
  if (h > 0) return h + ' 小时后重置'
  if (m > 0) return m + ' 分钟后重置'
  return sec + ' 秒后重置'
}
function hashHue(id) {
  var h = 0
  for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

function makeCard(source) {
  var card = document.createElement('div')
  card.className = 'ocuw-card'
  card.dataset.id = source.id
  var head = document.createElement('div')
  head.className = 'ocuw-head'
  var img = document.createElement('img')
  img.className = 'ocuw-icon'
  img.alt = ''
  img.src = source.icon || ''
  img.onerror = function () {
    if (ICON_FAILED[source.id]) return
    ICON_FAILED[source.id] = true
    var init = document.createElement('div')
    init.className = 'ocuw-initial'
    init.style.background = 'hsl(' + hashHue(source.id) + ' 45% 42%)'
    init.textContent = (source.name || '?').trim().charAt(0)
    img.parentNode.replaceChild(init, img)
  }
  var name = document.createElement('span')
  name.className = 'ocuw-name'
  name.textContent = source.name || source.id
  var time = document.createElement('span')
  time.className = 'ocuw-time'
  head.appendChild(img)
  head.appendChild(name)
  head.appendChild(time)
  card.appendChild(head)
  card._rows = document.createElement('div')
  card.appendChild(card._rows)
  card._footer = document.createElement('div')
  card._footer.className = 'ocuw-footer'
  card.appendChild(card._footer)
  card._time = time
  return card
}

function updateCard(card, source, nowMs) {
  var usage = source.usage
  var rateLimited = !!(usage && usage.windows && usage.windows.some(function (w) { return w.status === 'rate-limited' }))
  card.classList.toggle('ocuw-rate-limited', !!rateLimited)
  var badge = card.querySelector('.ocuw-badge')
  if (rateLimited && !badge) {
    badge = document.createElement('div')
    badge.className = 'ocuw-badge'
    badge.textContent = '已限流'
    card.appendChild(badge)
  } else if (!rateLimited && badge) {
    badge.remove()
  }
  card._time.textContent = formatTime(typeof source.updatedAt === 'number' ? source.updatedAt : Date.parse(source.updatedAt || ''))
  card._rows.textContent = ''
  if (usage && usage.windows && usage.windows.length) {
    for (var i = 0; i < usage.windows.length; i++) {
      var w = usage.windows[i]
      var row = document.createElement('div')
      row.className = 'ocuw-row'
      var lab = document.createElement('span')
      lab.className = 'ocuw-row-label'
      lab.textContent = w.label || w.id
      var bar = document.createElement('div')
      bar.className = 'ocuw-bar'
      var fill = document.createElement('div')
      fill.className = 'ocuw-bar-fill'
      fill.style.width = (w.percent || 0) + '%'
      bar.appendChild(fill)
      var right = document.createElement('div')
      right.className = 'ocuw-row-right'
      var pct = document.createElement('span')
      pct.className = 'ocuw-pct'
      pct.textContent = (w.percent || 0) + '%'
      var reset = document.createElement('span')
      reset.className = 'ocuw-reset'
      reset.textContent = formatCountdown(w.resetsAt, nowMs)
      right.appendChild(pct)
      right.appendChild(reset)
      row.appendChild(lab)
      row.appendChild(bar)
      row.appendChild(right)
      card._rows.appendChild(row)
    }
  } else {
    card._rows.textContent = '暂无数据'
  }
  var err = source.error
  if (err && err.code !== 'NO_KEY') {
    card._footer.style.display = 'block'
    card._footer.textContent = (err.stale ? '使用最近数据 · ' : '') + (err.message || '获取失败')
  } else {
    card._footer.style.display = 'none'
  }
}

function render(data, nowMs) {
  state.data = data
  var sources = (data && data.sources) || []
  var byId = {}
  var kids = root.children
  for (var i = 0; i < kids.length; i++) if (kids[i].dataset && kids[i].dataset.id) byId[kids[i].dataset.id] = kids[i]
  var seen = {}
  for (var j = 0; j < sources.length; j++) {
    var s = sources[j]
    if (s.error && s.error.code === 'NO_KEY') continue // 自动发现：无 key 的源隐藏
    seen[s.id] = true
    var card = byId[s.id]
    if (!card) {
      card = makeCard(s)
      root.appendChild(card)
      byId[s.id] = card
    }
    updateCard(card, s, nowMs)
  }
  for (var id in byId) if (!seen[id]) byId[id].remove()
  var msg = root.querySelector('.ocuw-msg')
  if (root.children.length === 0) {
    if (!msg) {
      msg = document.createElement('div')
      msg.className = 'ocuw-msg'
      msg.textContent = '暂无可用订阅'
      root.appendChild(msg)
    }
  } else if (msg) {
    msg.remove()
  }
}

function refresh() {
  var ctrl = new AbortController()
  var timer = setTimeout(function () { ctrl.abort() }, FETCH_TIMEOUT_MS)
  fetch(DASHBOARD_URL, { cache: 'no-store', signal: ctrl.signal })
    .then(function (r) { return r.json() })
    .then(function (d) { render(d, Date.now()) })
    .catch(function () {
      if (state.data) return // 保留最近数据
      var msg = root.querySelector('.ocuw-msg')
      if (!msg) {
        msg = document.createElement('div')
        msg.className = 'ocuw-msg'
        root.appendChild(msg)
      }
      msg.textContent = '无法连接 /usage/dashboard.json，点击重试'
    })
    .finally(function () { clearTimeout(timer) })
}

var pressedCard = null
function clearPress() {
  if (pressedCard) { pressedCard.classList.remove('ocuw-pressed'); pressedCard = null }
}
root.addEventListener('pointerdown', function (e) {
  var el = e.target
  var card = el && el.closest ? el.closest('.ocuw-card') : null
  if (card) { pressedCard = card; card.classList.add('ocuw-pressed') }
})
window.addEventListener('pointerup', clearPress)
window.addEventListener('pointercancel', clearPress)
root.addEventListener('pointerleave', clearPress)
root.addEventListener('click', function () { refresh() })
setInterval(refresh, REFRESH_MS)
setInterval(function () { if (state.data) render(state.data, Date.now()) }, TICK_MS)
refresh()
})()`

export { name, inject, apply, WIDGET_JS, SOURCES }