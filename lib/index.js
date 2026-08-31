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