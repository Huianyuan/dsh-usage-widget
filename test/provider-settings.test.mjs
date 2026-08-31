import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSettingsProvider } from '../lib/index.js'

test('parseSettingsProvider: 提取 agent-default-model 的 provider', () => {
  const yaml = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: openrouter
  model: google/gemma-4-26b-a4b-it:free
llm-pi-ai:
  providers: {}
`
  assert.equal(parseSettingsProvider(yaml), 'openrouter')
})

test('parseSettingsProvider: 带引号的值去引号', () => {
  const yaml = 'agent-default-model:\n  provider: "opencode-go"\n  model: deepseek-v4-flash\n'
  assert.equal(parseSettingsProvider(yaml), 'opencode-go')
})

test('parseSettingsProvider: 无 agent-default-model 或文件损坏返回 null', () => {
  assert.equal(parseSettingsProvider('ui-onboarding: {}\n'), null)
  assert.equal(parseSettingsProvider(''), null)
  assert.equal(parseSettingsProvider(null), null)
  assert.equal(parseSettingsProvider('agent-default-model:\n  model: x\n'), null) // 无 provider 键
})