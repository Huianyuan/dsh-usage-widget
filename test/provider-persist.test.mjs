import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readActiveProviderFrom, persistActiveProviderTo, extractProviderFromEvent } from '../lib/index.js'

test('persist/read 回环（首次无文件返回 null）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ocw-act-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const f = join(dir, 'active.json')
  assert.equal(readActiveProviderFrom(f), null)
  assert.equal(persistActiveProviderTo(f, 'opencode-go'), true)
  assert.equal(readActiveProviderFrom(f), 'opencode-go')
})

test('extractProviderFromEvent: request/context 与 assistant/message 均能提取', () => {
  assert.equal(
    extractProviderFromEvent({ type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-v4-flash' } }),
    'deepseek',
  )
  assert.equal(
    extractProviderFromEvent({ type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'opencode-go', model: 'x' } } } }),
    'opencode-go',
  )
  assert.equal(extractProviderFromEvent({ type: 'assistant/message', data: { message: { source: { kind: 'tool' } } } }), null)
  assert.equal(extractProviderFromEvent({ type: 'turn/start', data: { turn: 1 } }), null)
  assert.equal(extractProviderFromEvent(null), null)
})