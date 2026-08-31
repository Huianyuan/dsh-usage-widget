import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSourcesByProvider, SOURCES } from '../lib/index.js'

const views = SOURCES.map((s) => ({ id: s.id, name: s.name }))

test('provider 命中时只保留对应源', () => {
  const out = selectSourcesByProvider(views, SOURCES, 'opencode-go')
  assert.deepEqual(out.map((v) => v.id), ['opencode-go'])
})

test('provider 未命中任何源时显示全部（兜底）', () => {
  const out = selectSourcesByProvider(views, SOURCES, 'openrouter')
  assert.deepEqual(out.map((v) => v.id).sort(), ['deepseek', 'opencode-go'])
})

test('无 provider（尚未发消息/无法检测）时显示全部', () => {
  assert.equal(selectSourcesByProvider(views, SOURCES, null), views)
  assert.equal(selectSourcesByProvider(views, SOURCES, undefined), views)
})

test('源无 providerHints 时始终可显示', () => {
  const v = [{ id: 'x' }]
  const srcs = [{ id: 'x' }]
  assert.deepEqual(selectSourcesByProvider(v, srcs, 'anything'), v)
})