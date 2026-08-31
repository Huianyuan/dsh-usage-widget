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

const name = 'opencode-go-widget'
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

// 最小版前端：Task 6 替换为完整仪表盘卡片
const WIDGET_JS = `(function () {
if (window.__ocUsageWidget) return
window.__ocUsageWidget = true
var root = document.createElement('div')
root.textContent = 'OpenCode Go 用量加载中…'
root.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:rgba(255,255,255,.94);border:1px solid rgba(31,38,82,.28);border-radius:12px;padding:12px 14px;font:12px sans-serif;color:#5b6390'
document.body.appendChild(root)
fetch('/usage/dashboard.json', { cache: 'no-store' })
  .then(function (r) { return r.json() })
  .then(function (d) { root.textContent = 'sources: ' + (d.sources || []).length })
  .catch(function () { root.textContent = '无法连接 /usage/dashboard.json' })
})()`

export { name, inject, apply, WIDGET_JS, SOURCES }