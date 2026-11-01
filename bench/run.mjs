// 跑 config × task 矩阵，逐次落盘 results/<cfg>-<task>-r<i>.json
// 用法：node run.mjs [--configs c0,c2] [--tasks t1,t4] [--runs 3] [--runbase 1] [--no-warmup] [--timeout 900]
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BENCH, cfg, cleanEnv } from './config.mjs'

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch'])
const args = process.argv.slice(2)
const opt = (n, d) => (args.indexOf(`--${n}`) === -1 ? d : args[args.indexOf(`--${n}`) + 1])
const flag = (n) => args.includes(`--${n}`)

const CONFIGS = opt('configs', 'c0').split(',')
const TASKS = opt('tasks', 't1').split(',')
const RUNS = Number(opt('runs', '1'))
const RUNBASE = Number(opt('runbase', '1'))
const TIMEOUT_MS = Number(opt('timeout', '900')) * 1000
const WARMUP = !flag('no-warmup')

const TASKS_JSON = JSON.parse(readFileSync(join(BENCH, 'tasks.json'), 'utf8'))
mkdirSync(cfg.resultsDir, { recursive: true })
const RAW = join(cfg.resultsDir, 'raw')
mkdirSync(RAW, { recursive: true })
const { readEvents } = await import(pathToFileURL(join(BENCH, 'lib', 'session-events.mjs')).href)

// 确定性铺测试文件（LCG，保证每次内容一致）
function seedFixture(dir, n) {
  let s = 20261101
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
  const words = ['缓存', '命中', '延迟', '带宽', '峰时', '重传', '调度', '队列', '抖动', '丢包']
  for (let i = 1; i <= n; i += 1) {
    const lines = 30 + Math.floor(rnd() * 90)
    const out = [`# 样本 ${i}`, '']
    for (let l = 0; l < lines; l += 1) {
      const k = 3 + Math.floor(rnd() * 6)
      const row = []
      for (let w = 0; w < k; w += 1) row.push(words[Math.floor(rnd() * words.length)])
      out.push(`- ${row.join('')}，第 ${l + 1} 段说明文字。`)
    }
    writeFileSync(join(dir, `sample-${String(i).padStart(2, '0')}.md`), out.join('\n') + '\n')
  }
}

function walk(root) {
  if (!existsSync(root)) return []
  const out = []
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else out.push(p)
    }
  }
  return out
}

function findLog(home, sessionId) {
  const key = sessionId.replace(/^session-/, '')
  return walk(join(cfg.homeRoot, home, 'sessions')).find((p) => p.endsWith('session.v4.jsonl.zstd') && p.includes(key)) ?? null
}

function runOne(name, taskId, idx, prompt) {
  return new Promise((resolvePromise) => {
    const spec = TASKS_JSON[taskId]
    // 目录按 (配置,任务) 固定：cwd 会进系统提示，换路径会让前缀缓存整段失效
    const cwd = join(cfg.workRoot, `${name}-${taskId}`)
    rmSync(cwd, { recursive: true, force: true })
    mkdirSync(cwd, { recursive: true })
    if (spec.fixture) seedFixture(cwd, spec.fixture)

    const home = join(cfg.homeRoot, name)
    const started = Date.now()
    const child = spawn(process.execPath, [cfg.dshBin, '--profile', cfg.profile, '--json', prompt], { cwd, env: cleanEnv(home), windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      const wallMs = Date.now() - started
      const events = stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)

      let outTok = 0, inMiss = 0, cacheRead = 0, steps = 0, turns = 0, sessionId = null, answer = ''
      for (const e of events) {
        if (e.type === 'session') sessionId = e.sessionId
        if (e.type === 'final') answer = e.text ?? ''
        if (e.type === 'status' && e.phase === 'step_end') {
          steps += 1
          turns = Math.max(turns, e.turn ?? 0)
          const u = e.usage ?? {}
          outTok += u.outputTokens ?? 0
          inMiss += u.inputTokens ?? 0
          cacheRead += u.cacheReadTokens ?? 0
        }
      }

      let toolCalls = 0, writes = 0, writeChars = 0, rewrites = 0, reasonChars = 0
      const toolNames = {}
      const logFile = sessionId ? findLog(name, sessionId) : null
      if (logFile) {
        try {
          const seen = new Map()
          for (const e of readEvents(logFile)) {
            if (e.type === 'tool/call') {
              toolCalls += 1
              const nm = e.data?.name ?? '?'
              toolNames[nm] = (toolNames[nm] ?? 0) + 1
              if (!WRITE_TOOLS.has(nm)) continue
              let a = {}
              try { a = JSON.parse(e.data?.arguments ?? '{}') } catch { /* 忽略非 JSON */ }
              const p = a.path ?? a.file_path ?? a.filePath ?? '?'
              writes += 1
              writeChars += String(a.content ?? a.new_string ?? a.newString ?? '').length
              seen.set(p, (seen.get(p) ?? 0) + 1)
            } else if (e.type === 'assistant/message') {
              for (const b of e.data?.content ?? e.data?.message?.content ?? []) if (b.type === 'reasoning') reasonChars += String(b.text ?? '').length
            }
          }
          for (const n of seen.values()) rewrites += Math.max(0, n - 1)
        } catch { /* 日志读不动就算了 */ }
      }

      const files = walk(cwd).filter((p) => !/sample-\d\d\.md$/.test(p))
      const bytes = files.reduce((s, p) => s + statSync(p).size, 0)
      const price = cfg.price
      const cost = (inMiss * price.cacheMiss + cacheRead * price.cacheHit + outTok * price.output) / 1e6
      const costSteady = ((inMiss + cacheRead) * price.cacheHit + outTok * price.output) / 1e6

      const row = {
        cfg: name, task: taskId, kind: spec.kind, run: idx, code, wallMs, sessionId,
        steps, turns, outTok, inMiss, cacheRead,
        cost: Number(cost.toFixed(5)), costSteady: Number(costSteady.toFixed(5)),
        toolCalls, toolNames, writes, writeChars, rewrites, reasonChars,
        files: files.length, bytes, answerChars: answer.length,
      }
      const tag = `${name}-${taskId}-r${idx}`
      writeFileSync(join(RAW, `${tag}.jsonl`), stdout)
      if (stderr.trim()) writeFileSync(join(RAW, `${tag}.stderr.log`), stderr)
      writeFileSync(join(cfg.resultsDir, `${tag}.json`), JSON.stringify(row, null, 2))
      resolvePromise(row)
    })
  })
}

// 预检：每个配置的隔离 home 必须先由 setup.mjs 建好，否则 dsh 会报 profile 不存在
const missing = CONFIGS.filter((n) => !existsSync(join(cfg.homeRoot, n, 'profiles', cfg.profile, 'cordis.yml')))
if (missing.length) {
  console.error(`这些配置还没有 home：${missing.join(', ')}\n先执行：node setup.mjs`)
  process.exit(1)
}

for (const name of CONFIGS) {
  for (const taskId of TASKS) {
    if (WARMUP) {
      process.stdout.write(`预热 ${name}/${taskId} ... `)
      const w = await runOne(name, taskId, 0, '回复两个字：收到')
      console.log(`miss=${w.inMiss} read=${w.cacheRead}`)
    }
    for (let i = RUNBASE; i < RUNBASE + RUNS; i += 1) {
      process.stdout.write(`跑到 ${name}/${taskId}/r${i} ... `)
      const row = await runOne(name, taskId, i, TASKS_JSON[taskId].prompt)
      console.log(`exit=${row.code} steps=${row.steps} out=${row.outTok} $${row.costSteady} ${Math.round(row.wallMs / 1000)}s`)
    }
  }
}
