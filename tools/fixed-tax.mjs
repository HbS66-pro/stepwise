// 输入端盘点：每步固定税（system / tools / 消息），以及它值多少钱
// 用法：DSH_HOME=~/.dsh node tools/fixed-tax.mjs [--home <path>] [--json]
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (n) => (args.indexOf(`--${n}`) === -1 ? null : args[args.indexOf(`--${n}`) + 1])
const HOME = opt('home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const DIR = join(HOME, 'storages', 'session_projcache', 'sessions')
if (!existsSync(DIR)) {
  console.error(`找不到 ${DIR}\n用 --home 指定 DSH_HOME，或先设置环境变量 DSH_HOME`)
  process.exit(1)
}

const PRICE_CACHE_HIT = 0.003 // 美元 / 百万 token
const rows = []
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
  let j
  try { j = JSON.parse(readFileSync(join(DIR, f), 'utf8')) } catch { continue }
  const r = j.record?.rows
  const b = r?.contextBreakdown?.val?.breakdown
  if (!b) continue
  rows.push({
    preset: r?.agentPreset?.val ?? '?',
    sys: Number(b.systemTokens ?? 0),
    tools: Number(b.toolsTokens ?? 0),
    msg: Number(b.messageTokens ?? 0),
    steps: Number(r?.sessionStats?.val?.steps ?? 0),
  })
}
if (!rows.length) {
  console.error('没读到 contextBreakdown：这台机器的会话记录里没有固定税快照')
  process.exit(1)
}

const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0 }
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)))
const fixed = rows.map((r) => r.sys + r.tools)

console.log(`会话 ${rows.length} 个   中位固定税 ${k(med(fixed))} token/步（system ${k(med(rows.map((r) => r.sys)))} + tools ${k(med(rows.map((r) => r.tools)))}）`)
console.log(`消息历史中位 ${k(med(rows.map((r) => r.msg)))} token/步\n`)

const byPreset = new Map()
for (const r of rows) {
  const g = byPreset.get(r.preset) ?? []
  g.push(r)
  byPreset.set(r.preset, g)
}
console.log('档位        n    固定税/步    每万步成本')
for (const [p, g] of [...byPreset].sort((a, b) => b[1].length - a[1].length)) {
  const f = med(g.map((r) => r.sys + r.tools))
  const per10k = (f * 10000 * PRICE_CACHE_HIT) / 1e6
  console.log(`${p.padEnd(11)}${String(g.length).padStart(3)}  ${k(f).padStart(9)}  ${('$' + per10k.toFixed(2)).padStart(11)}`)
}

const f = med(fixed)
console.log(`\n换算：固定税每减少 1,000 token，每万步省 $${((1000 * 10000 * PRICE_CACHE_HIT) / 1e6).toFixed(2)}（缓存命中价）`)
console.log(`当前固定税 ${k(f)} token：每万步 $${((f * 10000 * PRICE_CACHE_HIT) / 1e6).toFixed(2)}`)
console.log('注意：第一轮请求按未命中价（0.15）计，是缓存价的 50 倍；上面的数是稳态。')

if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2))
