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
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// ---------- 提供商记忆（持久化「上次用的订阅」，首次打开不再全部显示） ----------
export function readActiveProviderFrom(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof o.provider === 'string' && o.provider ? o.provider : null
  } catch {
    return null
  }
}
export function persistActiveProviderTo(file, provider) {
  try {
    fs.writeFileSync(file, JSON.stringify({ provider, ts: Date.now() }), 'utf8')
    return true
  } catch {
    return false
  }
}

// 从会话事件中提取提供商（provider 路由 id）；无则返回 null
export function extractProviderFromEvent(event) {
  try {
    if (!event || typeof event !== 'object') return null
    if (event.type === 'request/context' && event.data && typeof event.data.provider === 'string' && event.data.provider) {
      return event.data.provider // RequestContext { provider, model }
    }
    if (event.type === 'assistant/message') {
      const src = event.data && event.data.message && event.data.message.source
      if (src && src.kind === 'model' && typeof src.provider === 'string' && src.provider) return src.provider
    }
  } catch {}
  return null
}

// 从 $DSH_HOME/settings.yaml 提取 agent-default-model.provider（聊天里切换模型会写这个文件）
export function parseSettingsProvider(text) {
  if (typeof text !== 'string') return null
  const m = text.match(/agent-default-model:[\s\S]*?provider:\s*["']?([^\s"'\n#]+)["']?/)
  return m ? m[1] : null
}

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

// ---------- DeepSeek：余额 + 用量（定价沿用小鲸鱼已验证的峰谷表，MIT 参考项目） ----------
const DS_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DS_USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
// 高峰时段：工作日 9:00–12:00 与 14:00–18:00（北京时间）；2026-08-23 起周末全天谷价
const PEAK_HOURS = [[9, 12], [14, 18]]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

export function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

export function parseBalance(data) {
  const infos = data && Array.isArray(data.balance_infos) ? data.balance_infos : []
  const pick = infos.find((x) => x && x.currency === 'CNY') || infos[0]
  if (!pick) throw new Error('deepseek balance: empty balance_infos')
  const num = (v) => {
    const n = Number(v)
    return isFinite(n) ? n : 0
  }
  return {
    toppedUp: num(pick.topped_up_balance),
    granted: num(pick.granted_balance),
    total: num(pick.total_balance),
    currency: String(pick.currency || 'CNY'),
    available: data.is_available !== false,
  }
}

export function computeDeepseekUsage(data, boundaries) {
  let d = data
  if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
  else if (d && d.data && Array.isArray(d.data.series)) d = d.data
  const series = Array.isArray(d.series) ? d.series : null
  if (!series || series.length === 0) throw new Error('deepseek usage: empty series')
  const totals = { today: 0, week: 0, month: 0 }
  for (const s of series) {
    if (!s || typeof s !== 'object') continue
    const p = priceFor(s.model)
    const buckets = Array.isArray(s.buckets) ? s.buckets : []
    for (const b of buckets) {
      const u = b && b.usage
      if (!u || typeof u !== 'object') continue
      const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
      const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
      const out = Number(u.RESPONSE_TOKEN) || 0
      if (hit + miss + out === 0) continue
      const t = Number(b.time)
      const pi = isPeakTime(t) ? 1 : 0
      const cost = (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi]
      if (t >= boundaries.monthStartSec) totals.month += cost
      if (t >= boundaries.weekStartSec) totals.week += cost
      if (t >= boundaries.todayStartSec) totals.today += cost
    }
  }
  return totals
}

const OPENCODE_GO = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  metric: 'percent-windows',
  providerHints: ['opencode-go', 'opencodego'],
  keyResolvers: [
    credentialResolver('OPENCODE_GO_API_KEY'),
    credentialResolver('OPENCODE_GO_KEY'),
    { label: 'auth.json', resolve: () => readAuthJsonKey(os.homedir()) },
    { label: 'config', resolve: () => readConfigJsonKey(os.homedir()) },
  ],
  async fetchUsage(keys) {
    const data = await fetchJson('https://opencode.ai/zen/go/v1/usage', {
      headers: { Authorization: 'Bearer ' + keys.primary },
      timeoutMs: FETCH_TIMEOUT_MS,
      retries: 1,
    })
    return normalizeUsagePayload(data)
  },
}

const DEEPSEEK = {
  id: 'deepseek',
  name: 'DeepSeek',
  metric: 'amount',
  providerHints: ['deepseek', 'deepseek-api', 'deepseek-official'],
  keyResolvers: [credentialResolver('DEEPSEEK_API_KEY')],
  extraKeyResolvers: [
    { id: 'platform', resolvers: [credentialResolver('DEEPSEEK_PLATFORM_TOKEN')] },
  ],
  async fetchUsage(keys) {
    const windows = []
    // 余额行（需要 DEEPSEEK_API_KEY）
    if (keys.primary) {
      const data = await fetchJson(DS_BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + keys.primary },
        timeoutMs: FETCH_TIMEOUT_MS,
        retries: 1,
      })
      const b = parseBalance(data)
      windows.push(
        { id: 'topped', label: '充值余额', amount: b.toppedUp, currency: b.currency, tone: b.toppedUp < 0 ? 'danger' : undefined },
        { id: 'granted', label: '赠送余额', amount: b.granted, currency: b.currency },
        { id: 'balance', label: '账户总额', amount: b.total, currency: b.currency, tone: !b.available ? 'danger' : undefined },
      )
    }
    // 消费估算行（需要 DEEPSEEK_PLATFORM_TOKEN；一次调用按月分区）
    if (keys.platform) {
      const now = new Date()
      const tz = -now.getTimezoneOffset() * 60
      const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000)
      const dow = (now.getDay() + 6) % 7 // 周一=0
      const weekStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow).getTime() / 1000)
      const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
      const end = Math.floor(Date.now() / 1000) + 60
      const url = DS_USAGE_URL + '?start=' + monthStart + '&end=' + end + '&tz=' + tz
      const data = await fetchJson(url, {
        headers: { Authorization: 'Bearer ' + keys.platform },
        timeoutMs: FETCH_TIMEOUT_MS,
        retries: 1,
      })
      const totals = computeDeepseekUsage(data, { todayStartSec: todayStart, weekStartSec: weekStart, monthStartSec: monthStart })
      const r2 = (v) => Math.round(v * 100) / 100
      windows.push(
        { id: 'today', label: '今日已用', amount: r2(totals.today), currency: 'CNY' },
        { id: 'month', label: '本月已用', amount: r2(totals.month), currency: 'CNY' },
      )
    }
    if (windows.length === 0) throw new Error('deepseek: no keys resolved')
    return { metric: 'amount', windows }
  },
}

const SOURCES = [OPENCODE_GO, DEEPSEEK]

// 按当前会话提供商过滤要展示的源：命中某源 → 只保留它；未命中/暂无 provider → 全部
// 匹配为「族前缀」规则：hint 'deepseek' 可命中 'deepseek-official'/'deepseek-api' 等同族 id
function providerMatches(hint, provider) {
  if (!hint || !provider) return false
  if (hint === provider) return true
  return provider.startsWith(hint + '-') || hint.startsWith(provider + '-')
}

export function selectSourcesByProvider(viewDescs, sources, provider) {
  if (!provider) return viewDescs
  const matched = sources
    .filter((s) => (s.providerHints || []).some((h) => providerMatches(h, provider)))
    .map((s) => s.id)
  if (matched.length === 0) return viewDescs
  return viewDescs.filter((v) => matched.includes(v.id))
}

function trunc(s, n) {
  const t = String((s && s.message) || s || '')
  return t.length > n ? t.slice(0, n) + '\u2026' : t
}

const name = 'dsh-usage-widget'
const inject = ['webServer', 'credentials']

function apply(ctx) {
  const runtimes = new Map() // sourceId -> { cache: {at,payload}|null, inflight: Promise|null }
  const iconCache = new Map() // sourceId -> Buffer
  const disposers = []
  const sseClients = new Set() // 长驻 /usage/stream 连接
  const activeFile = path.join(DSH_HOME, '.dsh-usage-active.json')
  let activeProvider = readActiveProviderFrom(activeFile) // 首次打开沿用上次的提供商
  let providerRevision = 0

  // 监听 $DSH_HOME/settings.yaml：聊天里切换模型会写 agent-default-model，文件一变立即跟随
  const settingsFile = path.join(DSH_HOME, 'settings.yaml')
  let lastSettingsText = null
  let settingsTimer = null

  function readSettingsProvider() {
    try {
      const txt = fs.readFileSync(settingsFile, 'utf8')
      lastSettingsText = txt
      return parseSettingsProvider(txt)
    } catch {
      return null
    }
  }

  function checkSettingsChange() {
    settingsTimer = null
    try {
      const txt = fs.readFileSync(settingsFile, 'utf8')
      if (txt === lastSettingsText) return
      lastSettingsText = txt
      const p = parseSettingsProvider(txt)
      if (p) setActiveProvider(p)
    } catch {}
  }

  {
    const p = readSettingsProvider()
    if (p && !activeProvider) setActiveProvider(p) // 无记忆时用当前默认模型
  }
  try {
    const watch = fs.watch(path.dirname(settingsFile), (evt, fname) => {
      if (!fname || String(fname) === path.basename(settingsFile)) {
        if (settingsTimer) clearTimeout(settingsTimer)
        settingsTimer = setTimeout(checkSettingsChange, 800) // 防抖：settings 写入可能连续触发
      }
    })
    disposers.push(() => { try { watch.close() } catch {} })
  } catch {}

  function broadcastProvider() {
    const body = 'event: provider\ndata: ' + JSON.stringify({ provider: activeProvider, revision: providerRevision }) + '\n\n'
    for (const res of sseClients) {
      try { res.write(body) } catch {}
    }
  }

  function setActiveProvider(p) {
    if (!p || p === activeProvider) return
    activeProvider = p
    providerRevision++
    persistActiveProviderTo(activeFile, p)
    broadcastProvider()
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    const p = extractProviderFromEvent(event)
    if (p) setActiveProvider(p)
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/usage/stream',
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      sseClients.add(res)
      broadcastProvider() // 新连接立即推当前状态
      req.on('close', () => sseClients.delete(res))
    },
  }))

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

  async function getSourceUsage(source, rk, extra) {
    let rt = runtimes.get(source.id)
    if (!rt) { rt = { cache: null, inflight: null }; runtimes.set(source.id, rt) }
    const now = Date.now()
    if (rt.cache && now - rt.cache.at < CACHE_TTL_MS) {
      return { usage: rt.cache.payload, error: null, updatedAt: rt.cache.at }
    }
    if (rt.inflight) return rt.inflight
    const p = (async () => {
      try {
        const usage = await source.fetchUsage({ ...(extra || {}), primary: rk.key })
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
      const extra = {}
      for (const e of source.extraKeyResolvers || []) {
        const er = await resolveKey(ctx, e.resolvers)
        extra[e.id] = er ? er.key : null
      }
      const u = await getSourceUsage(source, rk, extra)
      return { id: source.id, name: source.name, metric: source.metric, icon: '/usage/icon/' + source.id + '.svg', source: rk.source, usage: u.usage, updatedAt: u.updatedAt, error: u.error }
    }))
    const views = settled.map((s) => (s.status === 'fulfilled' ? s.value : {
        id: 'unknown', name: '未知订阅', metric: 'percent-windows', icon: null, source: null, usage: null, updatedAt: null, error: { code: 'ERROR', message: '内部错误' },
      }))
    const visible = selectSourcesByProvider(views, SOURCES, activeProvider)
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      activeProvider: activeProvider || null,
      sources: visible,
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
    for (const res of sseClients) {
      try { res.end() } catch {}
    }
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
  '.ocuw-row-amount{display:grid;grid-template-columns:84px 1fr;align-items:center;gap:8px;padding:3px 0}',
  '.ocuw-danger{color:#dc2626!important}',
  '.ocuw-bar{height:8px;border-radius:4px;background:rgba(31,38,82,.1);overflow:hidden}',
  '.ocuw-bar-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#34d399,#10b981);transition:width .5s ease}',
  '.ocuw-card.ocuw-rate-limited .ocuw-bar-fill{background:linear-gradient(90deg,#f87171,#dc2626)}',
  '.ocuw-row-right{text-align:right;display:flex;flex-direction:column;gap:1px}',
  '.ocuw-pct{font-size:14px;font-weight:800;color:#1f2652;line-height:1}',
  '.ocuw-reset{font-size:10px;color:#8a93b8;line-height:1}',
  '.ocuw-card.ocuw-rate-limited .ocuw-pct{color:#dc2626}',
  '.ocuw-footer{font-size:11px;color:#b0b6d4;margin-top:6px;border-top:1px dashed rgba(31,38,82,.15);padding-top:5px;line-height:1.4}',
  '.ocuw-msg{width:280px;box-sizing:border-box;background:rgba(255,255,255,.94);border:1px solid rgba(31,38,82,.28);border-radius:12px;padding:12px 14px;color:#8a93b8;font-size:12px;text-align:center;cursor:pointer}',
  '.ocuw-hint{width:280px;box-sizing:border-box;font-size:10px;color:#8a93b8;text-align:center;border-top:1px dashed rgba(31,38,82,.15);padding-top:4px}'
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
  var isAmount = !!(usage && usage.metric === 'amount')
  if (usage && usage.windows && usage.windows.length) {
    for (var i = 0; i < usage.windows.length; i++) {
      var w = usage.windows[i]
      var row = document.createElement('div')
      row.className = 'ocuw-row' + (isAmount ? ' ocuw-row-amount' : '')
      var lab = document.createElement('span')
      lab.className = 'ocuw-row-label'
      lab.textContent = w.label || w.id
      row.appendChild(lab)
      if (isAmount) {
        var amt = document.createElement('span')
        amt.className = 'ocuw-pct' + (w.tone === 'danger' ? ' ocuw-danger' : '')
        amt.textContent = (w.currency === 'CNY' ? '¥' : '') + Number(w.amount || 0).toFixed(2)
        amt.style.textAlign = 'right'
        row.appendChild(amt)
      } else {
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
        row.appendChild(bar)
        row.appendChild(right)
      }
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
  var hint = root.querySelector('.ocuw-hint')
  if (data && data.activeProvider && root.querySelector('.ocuw-card') && sources.length > 1) {
    if (!hint) {
      hint = document.createElement('div')
      hint.className = 'ocuw-hint'
      root.appendChild(hint)
    }
    hint.textContent = '当前提供商 ' + data.activeProvider + ' 未匹配订阅，显示全部'
  } else if (hint) {
    hint.remove()
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
var stream = null
try {
  stream = new EventSource('/usage/stream')
  stream.addEventListener('provider', function () { refresh() }) // provider 切换即时刷新（SSE）
} catch (err) { /* SSE 不可用时退化为轮询 */ }
refresh()
})()`

export { name, inject, apply, WIDGET_JS, SOURCES }