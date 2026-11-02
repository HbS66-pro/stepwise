// 汇总 results/*.json：逐格中位数 + 相对基线（c0）的净变化 + 空跑统计
// 用法：node report.mjs [--base c0]
//
// 成功判定（2026-11-02 修）：
//   旧版只看 code === 0，把"进程正常退出但一个字节没写"的空跑算成成功，
//   于是 doc/long 类任务的空跑会把该格中位数拉低，看起来像"省钱了"。
//   现在 doc / long 类若 bytes === 0 且 files === 0，记为 fail：不进中位数，
//   在表里单列"空跑"次数，并在表后逐条列出。chat / analyze（t1、t5）不要求落盘，不受影响。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cfg } from './config.mjs'

const args = process.argv.slice(2)
const BASE = args.indexOf('--base') === -1 ? 'c0' : args[args.indexOf('--base') + 1]
const REQUIRE_DELIVERABLE = new Set(['doc', 'long'])

const all = [] // 全部可解析结果（含 r0 预热、含空跑）
for (const f of readdirSync(cfg.resultsDir).filter((n) => /^[a-z0-9]+-t\d+-r\d+\.json$/.test(n))) {
  try {
    all.push({ file: f, ...JSON.parse(readFileSync(join(cfg.resultsDir, f), 'utf8')) })
  } catch { /* 跳过坏文件 */ }
}
if (!all.length) {
  console.error('results 里还没有结果，先跑 run.mjs')
  process.exit(1)
}

const isEmptyRun = (r) =>
  r.code === 0 && REQUIRE_DELIVERABLE.has(r.kind) && (r.bytes ?? 0) === 0 && (r.files ?? 0) === 0

// 有效样本：非 r0 预热 + 进程成功 + 有交付物（对 doc/long 而言）
const rows = all.filter((r) => r.run >= 1 && r.code === 0 && !isEmptyRun(r))
const empties = all.filter(isEmptyRun)
if (!rows.length) {
  console.error('没有有效结果（全部是预热或空跑），先跑 run.mjs')
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
const emptyCount = new Map()
for (const r of empties) {
  const key = `${r.task}|${r.cfg}`
  emptyCount.set(key, (emptyCount.get(key) ?? 0) + 1)
}

const pad = (v, n) => String(v).padEnd(n)
const table = []
table.push(['task', 'cfg', 'n', 'empty', 'steps', 'steps范围', 'outTok', 'cost$', 'tools', 'writes', 'rewrites', 'bytes', 'ansCh'].map((h) => pad(h, 11)).join(''))
for (const t of TASKS) {
  for (const c of CFGS) {
    const g = agg.get(`${t}|${c}`)
    const e = emptyCount.get(`${t}|${c}`) ?? 0
    if (!g) {
      if (e) table.push([pad(t, 11), pad(c, 11), pad(0, 11), pad(e, 11), pad('-', 11)].join(''))
      continue
    }
    table.push([
      pad(t, 11), pad(c, 11), pad(g.length, 11), pad(e, 11),
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

const emptyLines = empties
  .sort((a, b) => (a.task + a.cfg + a.run).localeCompare(b.task + b.cfg + b.run))
  .map((r) => `  ${r.task}/${r.cfg} r${r.run}  steps=${r.steps} bytes=${r.bytes} files=${r.files}  ${r.file}`)

const out = [
  `费用单位：milli-USD（千分之一美元，中位数），相对基线 ${BASE}`,
  `有效样本 = 非 r0 预热 且 code=0 且（doc/long 必须有落盘）；空跑单列、不进中位数`,
  '',
  table.join('\n'),
  '',
  delta.join('\n'),
  '',
  empties.length
    ? `空跑 ${empties.length} 次（code=0 但 doc/long 类 bytes=0 且 files=0）：\n${emptyLines.join('\n')}`
    : '空跑 0 次',
].join('\n')
console.log(out)
writeFileSync(join(cfg.resultsDir, 'summary.txt'), out + '\n')
