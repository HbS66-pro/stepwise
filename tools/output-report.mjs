#!/usr/bin/env node
/**
 * 输出端账单报告（stage 0）
 *
 * 数据源：<dshHome>/storages/session_projcache/sessions/*.json
 * 字段：record.rows.{tokenUsage,sessionStats,contextBreakdown,agentPreset,title}
 *
 * 用法：
 *   node output-report.mjs [--json] [--top N]
 *
 * 口径：
 *   - 费用按 deepseek-flash 闲时价折算；peak 价为两倍，未展开
 *   - contextBreakdown 是最后一次快照，不是每步平均
 *   - 子会话如单独成文件，会各占一行
 */

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

const PRICES = {
  offPeak: { hit: 0.003, miss: 0.15, out: 0.6 },
  peak: { hit: 0.006, miss: 0.3, out: 1.2 },
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const topArg = args.indexOf('--top')
const topN = topArg >= 0 ? Number(args[topArg + 1] ?? 10) : 10

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const val = (row) => (row && typeof row === 'object' && 'val' in row ? row.val : row)
const text = (row) => {
  const v = val(row)
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object' && typeof v.text === 'string') return v.text
  return ''
}

let files
try {
  files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
} catch {
  console.error(`projection dir not found: ${DIR}`)
  process.exit(2)
}

const sessions = []
for (const name of files) {
  let j
  try {
    j = JSON.parse(readFileSync(join(DIR, name), 'utf8'))
  } catch {
    continue
  }
  const rows = j?.record?.rows
  if (!rows) continue
  const t = val(rows.tokenUsage)?.totals ?? {}
  const s = val(rows.sessionStats) ?? {}
  const c = val(rows.contextBreakdown) ?? {}
  sessions.push({
    id: name.replace(/^session-/, '').replace(/\.json$/, ''),
    preset: String(val(rows.agentPreset) ?? 'unknown'),
    title: text(rows.title),
    turns: num(s.turns),
    steps: num(s.steps),
    out: num(t.outputTokens),
    hit: num(t.cacheReadTokens),
    miss: num(t.uncachedInputTokens),
    tools: num(c.breakdown?.toolsTokens),
    system: num(c.breakdown?.systemTokens),
    surface: num(c.surfaceTokens),
  })
}

const p = PRICES.offPeak
for (const s of sessions) {
  s.cost = (s.hit * p.hit + s.miss * p.miss + s.out * p.out) / 1e6
  s.outCost = (s.out * p.out) / 1e6
  s.outShare = s.cost > 0 ? s.outCost / s.cost : 0
  s.hitRate = s.hit + s.miss > 0 ? s.hit / (s.hit + s.miss) : 0
  s.ctxPerStep = s.steps > 0 ? s.surface / s.steps : 0
}

const total = sessions.reduce(
  (a, s) => {
    a.out += s.out; a.hit += s.hit; a.miss += s.miss; a.cost += s.cost; a.outCost += s.outCost
    return a
  },
  { out: 0, hit: 0, miss: 0, cost: 0, outCost: 0 },
)

const groups = new Map()
for (const s of sessions) {
  const g = groups.get(s.preset) ?? {
    preset: s.preset, n: 0, out: 0, hit: 0, miss: 0, cost: 0, outCost: 0,
    steps: 0, turns: 0, tools: 0, surface: 0,
  }
  g.n += 1; g.out += s.out; g.hit += s.hit; g.miss += s.miss; g.cost += s.cost; g.outCost += s.outCost
  g.steps += s.steps; g.turns += s.turns; g.tools += s.tools; g.surface += s.surface
  groups.set(s.preset, g)
}
const byPreset = [...groups.values()].sort((a, b) => b.cost - a.cost)

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)))
const money = (n) => `$${n.toFixed(2)}`
const pct = (n) => `${(n * 100).toFixed(0)}%`

if (asJson) {
  console.log(JSON.stringify({
    dshHome: DSH_HOME,
    sessions: sessions.length,
    total: {
      ...total,
      outShare: total.outCost / total.cost,
      hitRate: total.hit / (total.hit + total.miss),
    },
    byPreset: byPreset.map((g) => ({
      ...g,
      outShare: g.outCost / g.cost,
      hitRate: g.hit / (g.hit + g.miss),
      ctxPerStep: g.steps > 0 ? g.surface / g.steps : 0,
      avgTools: g.n > 0 ? g.tools / g.n : 0,
    })),
    rows: [...sessions].sort((a, b) => b.cost - a.cost),
  }, null, 2))
  process.exit(0)
}

console.log(`DSH_HOME: ${DSH_HOME}`)
console.log(`sessions: ${sessions.length}\n`)

console.log('preset        n       out      cost  out%  hit%   tools  in/step')
for (const g of byPreset) {
  const avgTools = g.n > 0 ? g.tools / g.n : 0
  const inStep = g.steps > 0 ? (g.hit + g.miss) / g.steps : 0
  console.log(
    `${g.preset.padEnd(12)} ${String(g.n).padStart(3)} ${k(g.out).padStart(9)} ${money(g.cost).padStart(9)} ` +
    `${pct(g.outCost / g.cost).padStart(5)} ${pct(g.hit / (g.hit + g.miss)).padStart(5)} ${k(avgTools).padStart(7)} ${k(inStep).padStart(9)}`,
  )
}
console.log('')
console.log(`TOTAL  out=${k(total.out)}  cost=${money(total.cost)}  out%=${pct(total.outCost / total.cost)}  hit%=${pct(total.hit / (total.hit + total.miss))}`)
console.log('')
console.log('top sessions by cost:')
console.log('id        preset       turns  steps       out      cost   out%   tools  in/step')
for (const s of [...sessions].sort((a, b) => b.cost - a.cost).slice(0, topN)) {
  const inStep = s.steps > 0 ? (s.hit + s.miss) / s.steps : 0
  console.log(
    `${s.id.slice(0, 8)}  ${s.preset.padEnd(12)} ${String(s.turns).padStart(5)} ${String(s.steps).padStart(6)} ` +
    `${k(s.out).padStart(9)} ${money(s.cost).padStart(9)} ${pct(s.outShare).padStart(5)} ${k(s.tools).padStart(7)} ${k(inStep).padStart(9)}`,
  )
}
