import test from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, apply, SOURCES, WIDGET_JS } from '../lib/index.js'

function fakeCtx() {
  const seen = { paths: [], tapIndexes: 0, effects: 0 }
  return {
    seen,
    credentials: { resolve: async () => null },
    webServer: {
      register: (r) => { seen.paths.push(r.path); return () => {} },
      tapIndex: () => { seen.tapIndexes++; return () => {} },
    },
    effect: (fn) => { seen.effects++; const cleanup = fn(); if (typeof cleanup === 'function') cleanup() },
  }
}

test('模块导出契约', () => {
  assert.equal(name, 'dsh-opencode-go-widget')
  assert.deepEqual(inject, ['webServer', 'credentials'])
  assert.equal(typeof apply, 'function')
})

test('SOURCES 注册表含 opencode-go 且契约完整', () => {
  assert.ok(Array.isArray(SOURCES) && SOURCES.length >= 1)
  const s = SOURCES[0]
  assert.equal(s.id, 'opencode-go')
  assert.equal(s.name, 'OpenCode Go')
  assert.equal(s.metric, 'percent-windows')
  assert.ok(Array.isArray(s.keyResolvers) && s.keyResolvers.length >= 3)
  for (const r of s.keyResolvers) assert.equal(typeof r.resolve, 'function')
  assert.equal(typeof s.fetchUsage, 'function')
})

test('apply 注册 dashboard/widget/icon 路由 + tapIndex，且可清理', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.ok(ctx.seen.paths.includes('/usage/dashboard.json'))
  assert.ok(ctx.seen.paths.includes('/usage/widget.js'))
  assert.ok(ctx.seen.paths.includes('/usage/icon/opencode-go.svg'))
  assert.equal(ctx.seen.tapIndexes, 1)
  assert.ok(ctx.seen.effects >= 1)
})

test('WIDGET_JS 是可解析的合法 JS（不执行，仅语法检查）', () => {
  assert.equal(typeof WIDGET_JS, 'string')
  assert.ok(WIDGET_JS.length > 100)
  new Function(WIDGET_JS) // 语法错误会在这里抛出
})