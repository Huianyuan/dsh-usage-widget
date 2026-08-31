import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSourcesByProvider, SOURCES } from '../lib/index.js'

const views = SOURCES.map((s) => ({ id: s.id, name: s.name }))

test('provider 精确命中时只保留对应源', () => {
  const out = selectSourcesByProvider(views, SOURCES, 'opencode-go')
  assert.deepEqual(out.map((v) => v.id), ['opencode-go'])
  const d = selectSourcesByProvider(views, SOURCES, 'deepseek')
  assert.deepEqual(d.map((v) => v.id), ['deepseek'])
})

test('provider 族前缀命中（deepseek-official / deepseek-api 归 deepseek）', () => {
  const a = selectSourcesByProvider(views, SOURCES, 'deepseek-official')
  assert.deepEqual(a.map((v) => v.id), ['deepseek'])
  const b = selectSourcesByProvider(views, SOURCES, 'deepseek-api-cn')
  assert.deepEqual(b.map((v) => v.id), ['deepseek'])
})

test('族匹配不跨界（openrouter 族不命中任何源）', () => {
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