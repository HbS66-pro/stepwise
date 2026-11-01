#!/usr/bin/env node
/**
 * 回收站内容构成：可见回答 vs 推理 vs 工具参数。
 *
 * 用法：node trash-content.mjs [--top N] [--json]
 *
 * 口径：字符数，不是 token；用于比较构成与趋势，不用于计费。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readEvents } from './session-events.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const TRASH = join(DSH_HOME, 'dsh-session-cleaner', 'trash')
const METAS = join(TRASH, 'meta')
const ITEMS = join(TRASH, 'items')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const topArg = args.indexOf('--top')
const topN = topArg >= 0 ? Number(args[topArg + 1] ?? 10) : 10

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const val = (row) => (row && typeof row === 'object' && 'val' in row ? row.val : row)
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)))

let files
try { files = readdirSync(METAS).filter((f) => f.endsWith('.json')) } catch { console.error(`meta not found: ${METAS}`); process.exit(2) }

const rows = []
let done = 0
for (const f of files) {
  let m
  try { m = JSON.parse(readFileSync(join(METAS, f), 'utf8')) } catch { continue }
  const id = m.id ?? f.replace(/\.json$/, '')
  const log = join(ITEMS, id, 'session.v4.jsonl.zstd')
  if (!existsSync(log)) continue

  let p = {}
  try { p = JSON.parse(m.projcacheRow ?? '{}') } catch { /* 旧记录没有投影行 */ }
  const r = p?.record?.rows
  const preset = String(val(r?.agentPreset) ?? 'unknown')
  const steps = num(val(r?.sessionStats)?.steps)

  let events
  try { events = readEvents(log) } catch { continue }

  let reasoning = 0
  let text = 0
  let argsChars = 0
  for (const e of events) {
    if (e.type === 'assistant/message') {
      for (const b of e.data?.message?.content ?? []) {
        if (b.type === 'reasoning') reasoning += String(b.text ?? '').length
        else if (b.type === 'text') text += String(b.text ?? '').length
      }
    } else if (e.type === 'tool/call') {
      argsChars += String(e.data?.arguments ?? '').length
    }
  }

  rows.push({
    id, preset, steps,
    reasoning, text, argsChars,
    textShare: reasoning + text > 0 ? text / (reasoning + text) : 0,
    lastTime: num(m.lastTime),
  })
  done += 1
  if (done % 20 === 0) process.stderr.write(`  ${done}/${files.length}\n`)
}

const total = rows.reduce((a, r) => ({
  reasoning: a.reasoning + r.reasoning, text: a.text + r.text, args: a.args + r.argsChars, steps: a.steps + r.steps,
}), { reasoning: 0, text: 0, args: 0, steps: 0 })

if (asJson) {
  console.log(JSON.stringify({ sessions: rows.length, total, rows }, null, 2))
  process.exit(0)
}

console.log(`sessions: ${rows.length}`)
console.log(`chars: reasoning=${k(total.reasoning)}  text=${k(total.text)}  toolArgs=${k(total.args)}`)
console.log(`per step: reasoning=${Math.round(total.reasoning / total.steps)}  text=${Math.round(total.text / total.steps)}  args=${Math.round(total.args / total.steps)}`)
console.log(`visible text share of (reasoning+text): ${(total.text / (total.reasoning + total.text) * 100).toFixed(0)}%\n`)

const groups = new Map()
for (const r of rows) {
  const month = r.lastTime ? new Date(r.lastTime).toISOString().slice(0, 7) : '?'
  const key = `${r.preset} ${month}`
  const g = groups.get(key) ?? { key, n: 0, reasoning: 0, text: 0, args: 0, steps: 0 }
  g.n += 1; g.reasoning += r.reasoning; g.text += r.text; g.args += r.argsChars; g.steps += r.steps
  groups.set(key, g)
}

console.log('preset/month        n   steps   reason/step  text/step  args/step  text%')
for (const g of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  console.log(
    `${g.key.padEnd(18)} ${String(g.n).padStart(3)} ${String(g.steps).padStart(7)} ` +
    `${String(Math.round(g.reasoning / g.steps)).padStart(12)} ${String(Math.round(g.text / g.steps)).padStart(10)} ` +
    `${String(Math.round(g.args / g.steps)).padStart(10)} ${((g.text / (g.reasoning + g.text)) * 100).toFixed(0).padStart(6)}%`,
  )
}

console.log('\ntop by visible text:')
for (const r of [...rows].sort((a, b) => b.text - a.text).slice(0, topN)) {
  const month = r.lastTime ? new Date(r.lastTime).toISOString().slice(0, 10) : '?'
  console.log(
    `${r.id.replace(/^session-/, '').slice(0, 8)}  ${r.preset.padEnd(10)} ${String(r.steps).padStart(5)} steps  ` +
    `text=${k(r.text).padStart(7)}  reason=${k(r.reasoning).padStart(8)}  share=${(r.textShare * 100).toFixed(0).padStart(3)}%  ${month}`,
  )
}
