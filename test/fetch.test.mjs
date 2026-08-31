import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchJson } from '../lib/index.js'

function stubFetch(fn) {
  const orig = globalThis.fetch
  globalThis.fetch = fn
  return () => { globalThis.fetch = orig }
}

test('fetchJson: 成功解析 JSON', async (t) => {
  const restore = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ a: 1 }) }))
  t.after(restore)
  assert.deepEqual(await fetchJson('https://example.test/x'), { a: 1 })
})

test('fetchJson: 5xx 重试 1 次后成功', async (t) => {
  let calls = 0
  const restore = stubFetch(async () => {
    calls++
    if (calls === 1) return { ok: false, status: 503 }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  t.after(restore)
  const out = await fetchJson('https://example.test/x', { retries: 1, retryDelayMs: 1 })
  assert.deepEqual(out, { ok: true })
  assert.equal(calls, 2)
})

test('fetchJson: 4xx 不重试，抛 HTTP 状态错误', async (t) => {
  let calls = 0
  const restore = stubFetch(async () => { calls++; return { ok: false, status: 401 } })
  t.after(restore)
  await assert.rejects(() => fetchJson('https://example.test/x', { retries: 1 }), (e) => e.status === 401)
  assert.equal(calls, 1)
})

test('fetchJson: 网络错误重试后仍失败则抛出最后错误', async (t) => {
  let calls = 0
  const restore = stubFetch(async () => { calls++; throw new Error('network down') })
  t.after(restore)
  await assert.rejects(() => fetchJson('https://example.test/x', { retries: 1, retryDelayMs: 1 }), /network down/)
  assert.equal(calls, 2)
})