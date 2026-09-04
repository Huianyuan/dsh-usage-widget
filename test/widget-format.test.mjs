import test from 'node:test'
import assert from 'node:assert/strict'
import { WIDGET_JS } from '../lib/index.js'

// 从 WIDGET_JS 模板字符串中按配平花括号提取指定函数（独立于浏览器执行）
function extractFn(name) {
  const marker = 'function ' + name
  const start = WIDGET_JS.indexOf(marker)
  assert.ok(start >= 0, name + ' 未在 WIDGET_JS 中找到')
  const fnStart = WIDGET_JS.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = fnStart; i < WIDGET_JS.length; i++) {
    const c = WIDGET_JS[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  assert.ok(end > 0, name + ' 花括号未配平')
  const chunk = WIDGET_JS.slice(start, end + 1)
  return new Function('return ' + chunk)()
}

const formatCountdown = extractFn('formatCountdown')
const clampDrag = extractFn('clampDrag')
const now = 0 // 统一以 0 为基准，iso 用秒数构造

test('formatCountdown: 官网同款措辞（天/小时/分钟）', () => {
  // 6 天 9 小时 05 分 → 26.92 天风格（26 天 22 小时）与 6.41 天（6 天 9 小时）与 57 分钟
  const sec = (d, h, m) => (d * 86400 + h * 3600 + m * 60) * 1000
  assert.equal(formatCountdown(new Date(sec(6, 9, 0)).toISOString(), now), '6 天 9 小时后重置')
  assert.equal(formatCountdown(new Date(sec(26, 21, 0)).toISOString(), now), '26 天 21 小时后重置')
  assert.equal(formatCountdown(new Date(sec(0, 0, 57)).toISOString(), now), '57 分钟后重置')
  assert.equal(formatCountdown(new Date(sec(0, 3, 5)).toISOString(), now), '3 小时 5 分钟后重置')
})

test('formatCountdown: 边界与异常', () => {
  const sec = (d, h, m) => (d * 86400 + h * 3600 + m * 60) * 1000
  assert.equal(formatCountdown(new Date(sec(1, 0, 0)).toISOString(), now), '1 天后重置')
  assert.equal(formatCountdown(new Date(sec(0, 2, 0)).toISOString(), now), '2 小时后重置')
  assert.equal(formatCountdown(new Date(0).toISOString(), now), '即将重置') // sec===0
  assert.equal(formatCountdown('', now), '')
  assert.equal(formatCountdown('not-a-date', now), '')
})

test('clampDrag: 视口内原样返回', () => {
  assert.deepEqual(clampDrag(50, 50, 280, 100, 1000, 800), { x: 50, y: 50 })
})

test('clampDrag: 越界钳制到视口内', () => {
  assert.deepEqual(clampDrag(-10, 900, 280, 100, 1000, 800), { x: 0, y: 700 })
  assert.deepEqual(clampDrag(2000, 2000, 280, 100, 1000, 800), { x: 720, y: 700 })
})

test('clampDrag: 挂件大于视口时钳到 0（不产生负坐标）', () => {
  assert.deepEqual(clampDrag(100, 100, 1200, 900, 1000, 800), { x: 0, y: 0 })
})