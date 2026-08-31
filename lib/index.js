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