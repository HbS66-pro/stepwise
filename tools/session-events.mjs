#!/usr/bin/env node
/**
 * 读取 DSH 会话日志（zstd 分帧 JSONL）。
 *
 * 日志文件是「每行一个 zstd 帧」的追加式格式，Node 的 zstdDecompressSync
 * 只解第一帧，所以这里按魔数切帧后逐帧解压。
 *
 * 用法：
 *   node session-events.mjs <session.v4.jsonl.zstd> [--types] [--sample <type>]
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

export function readEvents(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      offsets.push(i)
    }
  }
  const parts = []
  let i = 0
  while (i < offsets.length) {
    let j = i + 1
    let out = null
    while (j <= offsets.length) {
      const end = j < offsets.length ? offsets[j] : buf.length
      try {
        out = zstdDecompressSync(buf.subarray(offsets[i], end))
        break
      } catch {
        j += 1
      }
    }
    if (out) {
      parts.push(out)
      i = j
    } else {
      i += 1
    }
  }
  const text = Buffer.concat(parts).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 半行或被切坏的帧，跳过
    }
  }
  return events
}

if (process.argv[1] && process.argv[1].endsWith('session-events.mjs')) {
  const file = process.argv[2]
  const types = process.argv.includes('--types')
  const sampleIdx = process.argv.indexOf('--sample')
  const sampleType = sampleIdx >= 0 ? process.argv[sampleIdx + 1] : null

  const events = readEvents(file)
  console.log(`events: ${events.length}`)
  if (types || !sampleType) {
    const counts = new Map()
    for (const e of events) counts.set(e.type ?? '?', (counts.get(e.type ?? '?') ?? 0) + 1)
    for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${t}`)
  }
  if (sampleType) {
    const hit = events.find((e) => e.type === sampleType)
    console.log(JSON.stringify(hit, null, 2).slice(0, 3000))
  }
}
