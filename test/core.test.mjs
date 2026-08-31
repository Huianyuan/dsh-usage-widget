import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsagePayload, hashId } from '../lib/index.js'

test('normalizeUsagePayload: 合法响应映射三档窗口', () => {
  const out = normalizeUsagePayload({
    usage: {
      rolling: { status: 'ok', percent: 6, resetsAt: '2026-08-31T15:46:50Z' },
      weekly: { status: 'ok', percent: 2, resetsAt: '2026-09-07T00:00:00Z' },
      monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-27T12:18:37Z' },
    },
  })
  assert.equal(out.metric, 'percent-windows')
  assert.equal(out.windows.length, 3)
  assert.deepEqual(out.windows.map((w) => w.id), ['rolling', 'weekly', 'monthly'])
  assert.equal(out.windows[0].label, '5小时')
  assert.equal(out.windows[0].percent, 6)
  assert.equal(out.windows[0].status, 'ok')
  assert.equal(out.windows[2].status, 'rate-limited')
  assert.equal(out.windows[2].percent, 100)
  assert.equal(out.windows[1].resetsAt, '2026-09-07T00:00:00Z')
})

test('normalizeUsagePayload: percent 越界被钳制到 0-100', () => {
  const out = normalizeUsagePayload({
    usage: {
      rolling: { status: 'ok', percent: 150 },
      weekly: { status: 'ok', percent: -3 },
      monthly: { status: 'ok', percent: '7.4' },
    },
  })
  assert.equal(out.windows[0].percent, 100)
  assert.equal(out.windows[1].percent, 0)
  assert.equal(out.windows[2].percent, 7)
})

test('normalizeUsagePayload: 结构缺失/percent 非数抛错', () => {
  assert.throws(() => normalizeUsagePayload(null), /usage/)
  assert.throws(() => normalizeUsagePayload({ usage: {} }), /rolling/)
  assert.throws(() => normalizeUsagePayload({ usage: { rolling: { percent: 'x' }, weekly: {}, monthly: {} } }), /percent/)
})

test('hashId: 确定性且落在 0-359', () => {
  assert.equal(hashId('opencode-go'), hashId('opencode-go'))
  const hue = hashId('opencode-go')
  assert.ok(hue >= 0 && hue < 360)
})

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAuthJsonKey, readConfigJsonKey, resolveKey } from '../lib/index.js'

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'ocw-test-'))
  mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  return home
}

test('readAuthJsonKey / readConfigJsonKey', async (t) => {
  const home = makeFakeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(
    join(home, '.local', 'share', 'opencode', 'auth.json'),
    JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-auth-test' } }),
  )
  writeFileSync(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ provider: { opencodego: { options: { apiKey: 'sk-config-test' } } } }),
  )
  assert.equal(readAuthJsonKey(home), 'sk-auth-test')
  assert.equal(readConfigJsonKey(home), 'sk-config-test')
  assert.equal(readAuthJsonKey(home, 'nonexistent'), null)
  assert.equal(readConfigJsonKey(home, 'provider.other.options.apiKey'), null)
})

test('resolveKey: 凭据优先，链式回退，返回 source 标签', async () => {
  const resolvers = [
    { label: 'credential', resolve: async () => null },
    { label: 'auth.json', resolve: async () => 'sk-fallback' },
    { label: 'config', resolve: async () => 'sk-config' },
  ]
  const got = await resolveKey({}, resolvers)
  assert.deepEqual(got, { key: 'sk-fallback', source: 'auth.json' })
})

test('resolveKey: 剥掉 Bearer 前缀；全部解析失败返回 null', async () => {
  const withBearer = [
    { label: 'credential', resolve: async () => 'Bearer sk-abc' },
  ]
  assert.equal((await resolveKey({}, withBearer)).key, 'sk-abc')
  const none = [
    { label: 'credential', resolve: async () => null },
    { label: 'auth.json', resolve: async () => '' },
    { label: 'config', resolve: async () => undefined },
  ]
  assert.equal(await resolveKey({}, none), null)
})