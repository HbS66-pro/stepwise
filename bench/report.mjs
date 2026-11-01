// 汇总 results/*.json：逐格中位数 + 相对基线（c0）的净变化
// 用法：node report.mjs [--base c0]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cfg } from './config.mjs'

const args = process.argv.slice(2)
const BASE = args.indexOf('--base') === -1 ? 'c0' : args[args.indexOf('--base') + 1]

const rows = []
for (const f of readdirSync(cfg.resultsDir).filter((n) => /^[a-z0-9]+-t\d+-r[1-9]\d*\.json$/.test(n))) {
  try {
    const row = JSON.parse(readFileSync(join(cfg.resultsDir, f), 'utf8'))
    if (row.code === 0) rows.push(row) // 只统计成功跑完的
  } catch { /* 跳过坏文件 */ }
}
if (!rows.length) {
  console.error('results 里还没有结果，先跑 run.mjs')
  process.exit(1)
}

const med = (a) => {
  const b = [...a].sort((x, y) => x - y)
  if (!b.length) return 0
  return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2
}
const TASKS = [...new Set(rows.map((r) => r.task))].sort()
const CFGS = [...new Set(rows.map((r) => r.cfg))].sort()

const agg = new Map()
for (const r of rows) {
  const key = `${r.task}|${r.cfg}`
  const g = agg.get(key) ?? []
  g.push(r)
  agg.set(key, g)
}

const pad = (v, n) => String(v).padEnd(n)
const table = []
table.push(['task', 'cfg', 'n', 'steps', 'steps范围', 'outTok', 'cost$', 'tools', 'writes', 'rewrites', 'bytes', 'ansCh'].map((h) => pad(h, 11)).join(''))
for (const t of TASKS) {
  for (const c of CFGS) {
    const g = agg.get(`${t}|${c}`)
    if (!g) continue
    table.push([
      pad(t, 11), pad(c, 11), pad(g.length, 11),
      pad(Math.round(med(g.map((r) => r.steps))), 11),
      pad(`${Math.min(...g.map((r) => r.steps))}-${Math.max(...g.map((r) => r.steps))}`, 11),
      pad(Math.round(med(g.map((r) => r.outTok))), 11),
      pad((med(g.map((r) => r.costSteady)) * 1000).toFixed(2), 11),
      pad(Math.round(med(g.map((r) => r.toolCalls))), 11),
      pad(Math.round(med(g.map((r) => r.writes))), 11),
      pad(Math.round(med(g.map((r) => r.rewrites))), 11),
      pad(Math.round(med(g.map((r) => r.bytes))), 11),
      pad(Math.round(med(g.map((r) => r.answerChars))), 11),
    ].join(''))
  }
}

const delta = []
delta.push(['task', 'cfg', 'steps%', 'outTok%', 'cost%', 'tools%', 'rewrites%'].map((h) => pad(h, 11)).join(''))
const pct = (v, b) => (b ? `${((v / b - 1) * 100).toFixed(0)}%` : '-')
for (const t of TASKS) {
  const base = agg.get(`${t}|${BASE}`)
  if (!base) continue
  const bm = (f) => med(base.map(f))
  for (const c of CFGS.filter((x) => x !== BASE)) {
    const g = agg.get(`${t}|${c}`)
    if (!g) continue
    delta.push([
      pad(t, 11), pad(c, 11),
      pad(pct(med(g.map((r) => r.steps)), bm((r) => r.steps)), 11),
      pad(pct(med(g.map((r) => r.outTok)), bm((r) => r.outTok)), 11),
      pad(pct(med(g.map((r) => r.costSteady)), bm((r) => r.costSteady)), 11),
      pad(pct(med(g.map((r) => r.toolCalls)), bm((r) => r.toolCalls)), 11),
      pad(pct(med(g.map((r) => r.rewrites)), bm((r) => r.rewrites)), 11),
    ].join(''))
  }
}

const out = `费用单位：milli-USD（千分之一美元，中位数），相对基线 ${BASE}\n\n${table.join('\n')}\n\n${delta.join('\n')}\n`
console.log(out)
writeFileSync(join(cfg.resultsDir, 'summary.txt'), out)
