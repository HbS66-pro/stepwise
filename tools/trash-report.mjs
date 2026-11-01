#!/usr/bin/env node
/**
 * 回收站会话报告：用 dsh-session-cleaner 的 meta 里内嵌的 projcacheRow 出数。
 *
 * 用法：
 *   node trash-report.mjs [--json] [--top N]
 *
 * 口径：与 output-report.mjs 一致（deepseek-flash 闲时价）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const META = join(DSH_HOME, 'dsh-session-cleaner', 'trash', 'meta')
const PRICES = { hit: 0.003, miss: 0.15, out: 0.6 }

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const topArg = args.indexOf('--top')
const topN = topArg >= 0 ? Number(args[topArg + 1] ?? 10) : 10

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const val = (row) => (row && typeof row === 'object' && 'val' in row ? row.val : row)

let files
try { files = readdirSync(META).filter((f) => f.endsWith('.json')) } catch { console.error(`meta dir not found: ${META}`); process.exit(2) }

const rows = []
for (const f of files) {
  let m
  try { m = JSON.parse(readFileSync(join(META, f), 'utf8')) } catch { continue }
  let p
  try { p = JSON.parse(m.projcacheRow ?? '{}') } catch { continue }
  const r = p?.record?.rows
  if (!r) continue
  const t = val(r.tokenUsage)?.totals ?? {}
  const s = val(r.sessionStats) ?? {}
  const c = val(r.contextBreakdown) ?? {}
  const out = num(t.outputTokens)
  const hit = num(t.cacheReadTokens)
  const miss = num(t.uncachedInputTokens)
  const cost = (hit * PRICES.hit + miss * PRICES.miss + out * PRICES.out) / 1e6
  rows.push({
    id: m.id ?? f,
    title: m.title ?? '',
    preset: String(val(r.agentPreset) ?? 'unknown'),
    lastTime: num(m.lastTime),
    turns: num(s.turns),
    steps: num(s.steps),
    out, hit, miss, cost,
    outShare: cost > 0 ? (out * PRICES.out) / 1e6 / cost : 0,
    hitRate: hit + miss > 0 ? hit / (hit + miss) : 0,
    inPerStep: s.steps > 0 ? (hit + miss) / s.steps : 0,
    tools: num(c.breakdown?.toolsTokens),
    system: num(c.breakdown?.systemTokens),
  })
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)))
const money = (n) => `$${n.toFixed(2)}`
const pct = (n) => `${(n * 100).toFixed(0)}%`
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?')

if (asJson) {
  console.log(JSON.stringify({ sessions: rows.length, rows }, null, 2))
  process.exit(0)
}

const total = rows.reduce((a, r) => ({ out: a.out + r.out, hit: a.hit + r.hit, miss: a.miss + r.miss, cost: a.cost + r.cost }), { out: 0, hit: 0, miss: 0, cost: 0 })

const byPreset = new Map()
for (const r of rows) {
  const g = byPreset.get(r.preset) ?? { preset: r.preset, n: 0, out: 0, cost: 0, hit: 0, miss: 0, steps: 0, tools: 0, from: Infinity, to: 0 }
  g.n += 1; g.out += r.out; g.cost += r.cost; g.hit += r.hit; g.miss += r.miss; g.steps += r.steps; g.tools += r.tools
  g.from = Math.min(g.from, r.lastTime || Infinity); g.to = Math.max(g.to, r.lastTime || 0)
  byPreset.set(r.preset, g)
}

console.log(`trash sessions: ${rows.length}`)
console.log(`TOTAL out=${k(total.out)} cost=${money(total.cost)} out%=${pct((total.out * PRICES.out) / 1e6 / total.cost)} hit%=${pct(total.hit / (total.hit + total.miss))}\n`)

console.log('preset        n       out      cost  out%  hit%   tools  in/step   period')
for (const g of [...byPreset.values()].sort((a, b) => b.cost - a.cost)) {
  console.log(
    `${g.preset.padEnd(12)} ${String(g.n).padStart(3)} ${k(g.out).padStart(9)} ${money(g.cost).padStart(9)} ` +
    `${pct((g.out * PRICES.out) / 1e6 / g.cost).padStart(5)} ${pct(g.hit / (g.hit + g.miss)).padStart(5)} ` +
    `${k(g.tools / g.n).padStart(7)} ${k(g.steps ? (g.hit + g.miss) / g.steps : 0).padStart(8)}  ${day(g.from)}~${day(g.to)}`,
  )
}

console.log('\nby month:')
const byMonth = new Map()
for (const r of rows) {
  const key = r.lastTime ? new Date(r.lastTime).toISOString().slice(0, 7) : '?'
  const g = byMonth.get(key) ?? { n: 0, out: 0, cost: 0, hit: 0, miss: 0 }
  g.n += 1; g.out += r.out; g.cost += r.cost; g.hit += r.hit; g.miss += r.miss
  byMonth.set(key, g)
}
for (const [key, g] of [...byMonth].sort()) {
  console.log(`${key}  n=${String(g.n).padStart(3)}  out=${k(g.out).padStart(8)}  cost=${money(g.cost).padStart(8)}  out%=${pct((g.out * PRICES.out) / 1e6 / g.cost).padStart(4)}`)
}

console.log('\ntop by output tokens:')
console.log('id        preset      turns  steps       out      cost   out%   tools  in/step  date')
for (const r of [...rows].sort((a, b) => b.out - a.out).slice(0, topN)) {
  console.log(
    `${r.id.replace(/^session-/, '').slice(0, 8)}  ${r.preset.padEnd(10)} ${String(r.turns).padStart(5)} ${String(r.steps).padStart(6)} ` +
    `${k(r.out).padStart(9)} ${money(r.cost).padStart(9)} ${pct(r.outShare).padStart(5)} ${k(r.tools).padStart(7)} ${k(r.inPerStep).padStart(8)}  ${day(r.lastTime)}`,
  )
}
