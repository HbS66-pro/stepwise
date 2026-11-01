// 读配置：bench/config.json（不存在则报错并提示复制 example）
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BENCH = dirname(fileURLToPath(import.meta.url))
const file = join(BENCH, 'config.json')
if (!existsSync(file)) {
  console.error('缺少 bench/config.json —— 先复制 bench/config.example.json 再填路径')
  process.exit(1)
}
const raw = JSON.parse(readFileSync(file, 'utf8'))

export const cfg = {
  dshBin: raw.dshBin,
  credentials: raw.credentials,
  profile: raw.profile ?? 'bench',
  provider: raw.provider ?? 'deepseek-official',
  model: raw.model ?? 'deepseek-flash',
  reasoningEffort: raw.reasoningEffort ?? 'max',
  homeRoot: resolve(BENCH, raw.homeRoot ?? '_homes'),
  workRoot: resolve(BENCH, raw.workRoot ?? '_work'),
  resultsDir: resolve(BENCH, raw.resultsDir ?? 'results'),
  price: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6, ...raw.price },
}

export function cleanEnv(dshHome) {
  const env = { ...process.env, DSH_HOME: dshHome, NO_COLOR: '1' }
  for (const k of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) delete env[k]
  return env
}
