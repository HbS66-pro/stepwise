#!/usr/bin/env node
/**
 * 会话事件统计：落盘字节、返工次数、工具结果体量。
 *
 * 用法：
 *   node session-stats.mjs [--tools] [--top N] [--json]
 *
 * 口径：
 *   - 落盘 = write/edit 调用写入的字符数（UTF-8 字节另算不值当，先用字符近似）
 *   - 返工 = 同一路径在会话内被写第 2 次及以后
 *   - 结果字节 = tool/result 文本内容累计
 */

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { readEvents } from './session-events.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ROOT = join(DSH_HOME, 'sessions')
const PROJ = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const WRITE_TOOLS = new Set(['write', 'edit'])

const args = process.argv.slice(2)
const showTools = args.includes('--tools')
const asJson = args.includes('--json')
const topArg = args.indexOf('--top')
const topN = topArg >= 0 ? Number(args[topArg + 1] ?? 8) : 8

function findLogs(dir, out = [], depth = 0) {
  if (depth > 3) return out
  let names
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) findLogs(p, out, depth + 1)
    else if (name.endsWith('.zstd')) out.push(p)
  }
  return out
}

function presetMap() {
  const map = new Map()
  let files
  try { files = readdirSync(PROJ).filter((f) => f.endsWith('.json')) } catch { return map }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(PROJ, f), 'utf8'))
      const rows = j?.record?.rows
      if (!rows) continue
      const p = rows.agentPreset?.val ?? 'unknown'
      const t = rows.tokenUsage?.val?.totals ?? {}
      const id = f.replace(/^session-/, '').replace(/\.json$/, '')
      map.set(id, { preset: String(p), out: Number(t.outputTokens ?? 0) })
    } catch { /* 跳过坏文件 */ }
  }
  return map
}

const presets = presetMap()
const logs = findLogs(ROOT)
const nameCounts = new Map()
const rows = []

for (const file of logs) {
  const id = basename(dirname(file)).replace(/^session-/, '')
  let events
  try { events = readEvents(file) } catch { continue }
  const writes = new Map()
  let calls = 0
  let resultChars = 0
  let assistantChars = 0

  for (const e of events) {
    if (e.type === 'tool/call') {
      calls += 1
      const name = e.data?.name ?? '?'
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
      if (!WRITE_TOOLS.has(name)) continue
      let a = {}
      try { a = JSON.parse(e.data?.arguments ?? '{}') } catch { /* 参数不是 JSON 就跳过 */ }
      const path = a.path ?? a.file_path ?? a.filePath ?? '?'
      const body = a.content ?? a.new_string ?? a.newString ?? ''
      const rec = writes.get(path) ?? { n: 0, chars: 0 }
      rec.n += 1
      rec.chars += String(body).length
      writes.set(path, rec)
    } else if (e.type === 'tool/result') {
      const content = e.data?.message?.content ?? []
      for (const c of content) if (c.type === 'text') resultChars += String(c.text ?? '').length
    } else if (e.type === 'assistant/message') {
      const content = e.data?.message?.content ?? []
      for (const c of content) if (c.type === 'text') assistantChars += String(c.text ?? '').length
    }
  }

  let writeChars = 0
  let rewrites = 0
  for (const rec of writes.values()) {
    writeChars += rec.chars
    rewrites += Math.max(0, rec.n - 1)
  }

  const meta = presets.get(id) ?? { preset: '?', out: 0 }
  rows.push({
    id, preset: meta.preset, out: meta.out,
    calls, files: writes.size, writeChars, rewrites, resultChars, assistantChars,
  })
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)))

if (showTools) {
  console.log('tool calls by name:')
  for (const [n, c] of [...nameCounts].sort((a, b) => b[1] - a[1])) console.log(`${String(c).padStart(6)}  ${n}`)
  console.log('')
}

if (asJson) {
  console.log(JSON.stringify({ sessions: rows.length, rows }, null, 2))
  process.exit(0)
}

const sum = (f) => rows.reduce((a, r) => a + f(r), 0)
console.log(`sessions with logs: ${rows.length}`)
console.log(`total: calls=${sum((r) => r.calls)}  writes=${sum((r) => r.files)} files  writeChars=${k(sum((r) => r.writeChars))}  rewrites=${sum((r) => r.rewrites)}  result=${k(sum((r) => r.resultChars))}  assistant=${k(sum((r) => r.assistantChars))}`)
console.log('')
console.log('id        preset      calls  files  writeKB  rewr  resultKB  answerKB   outK')
for (const r of [...rows].sort((a, b) => b.writeChars - a.writeChars).slice(0, topN)) {
  console.log(
    `${r.id.slice(0, 8)}  ${r.preset.padEnd(10)} ${String(r.calls).padStart(6)} ${String(r.files).padStart(6)} ` +
    `${k(r.writeChars / 1024).padStart(8)} ${String(r.rewrites).padStart(5)} ${k(r.resultChars / 1024).padStart(9)} ` +
    `${k(r.assistantChars / 1024).padStart(9)} ${k(r.out / 1000).padStart(6)}`,
  )
}
