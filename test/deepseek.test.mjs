import test from 'node:test'
import assert from 'node:assert/strict'
import { isPeakTime, priceFor, computeDeepseekUsage, parseBalance, SOURCES } from '../lib/index.js'

test('isPeakTime: 工作日 10:00 北京为高峰', () => {
  // 2026-08-31 是周一；02:00Z = 10:00 北京
  assert.equal(isPeakTime(Math.floor(Date.parse('2026-08-31T02:00:00Z') / 1000)), true)
})

test('isPeakTime: 工作日 20:00 北京为低谷', () => {
  assert.equal(isPeakTime(Math.floor(Date.parse('2026-08-31T12:00:00Z') / 1000)), false)
})

test('isPeakTime: 周末（2026-08-30 周六）全天谷价', () => {
  assert.equal(isPeakTime(Math.floor(Date.parse('2026-08-30T02:00:00Z') / 1000)), false)
})

test('priceFor: flash 用基础价，pro 用三倍价，未知回落默认', () => {
  assert.deepEqual(priceFor('deepseek-v4-flash'), { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] })
  assert.deepEqual(priceFor('deepseek-v4-pro'), { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] })
  assert.deepEqual(priceFor('unknown-model'), { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] })
})

test('computeDeepseekUsage: 按时间分区累加金额', () => {
  // 三个桶：epoch 400 / 900 / 1200（1970-01-01，北京时间 08:xx，均为谷价）
  // bucket@400: miss 100 万 token × 1.5/1e6 = 1.5
  // bucket@900: out 10 万 token × 4.5/1e6 = 0.45
  // bucket@1200: out 10 万 token × 4.5/1e6 = 0.45
  const boundaries = { todayStartSec: 1100, weekStartSec: 800, monthStartSec: 0 }
  const data = {
    data: {
      biz_data: {
        series: [{
          model: 'deepseek-v4-flash',
          buckets: [
            { time: 400, usage: { PROMPT_CACHE_MISS_TOKEN: '1000000', RESPONSE_TOKEN: '0', PROMPT_CACHE_HIT_TOKEN: '0' } },
            { time: 900, usage: { PROMPT_CACHE_MISS_TOKEN: '0', RESPONSE_TOKEN: '100000', PROMPT_CACHE_HIT_TOKEN: '0' } },
            { time: 1200, usage: { PROMPT_CACHE_MISS_TOKEN: '0', RESPONSE_TOKEN: '100000', PROMPT_CACHE_HIT_TOKEN: '0' } },
          ],
        }],
      },
    },
  }
  const out = computeDeepseekUsage(data, boundaries)
  assert.equal(out.month, 2.4) // 1.5 + 0.45 + 0.45
  assert.equal(out.week, 0.9) // 0.45 + 0.45
  assert.equal(out.today, 0.45) // 0.45
})

test('computeDeepseekUsage: 空数据抛错', () => {
  assert.throws(() => computeDeepseekUsage({}, { todayStartSec: 1, weekStartSec: 1, monthStartSec: 0 }), /series/)
})

test('parseBalance: 解析 balance_infos（含负余额）', () => {
  const out = parseBalance({
    is_available: false,
    balance_infos: [{ currency: 'CNY', total_balance: '-0.08', granted_balance: '0.00', topped_up_balance: '-0.08' }],
  })
  assert.deepEqual(out, { toppedUp: -0.08, granted: 0, total: -0.08, currency: 'CNY', available: false })
})

test('SOURCES 含 deepseek 源（余额 + 平台令牌双 key 契约）', () => {
  const s = SOURCES.find((x) => x.id === 'deepseek')
  assert.ok(s, 'deepseek 源未注册')
  assert.equal(s.name, 'DeepSeek')
  assert.equal(s.metric, 'amount')
  assert.ok(Array.isArray(s.keyResolvers) && s.keyResolvers.length >= 1)
  assert.ok(Array.isArray(s.extraKeyResolvers) && s.extraKeyResolvers.length >= 1)
  assert.equal(typeof s.fetchUsage, 'function')
})