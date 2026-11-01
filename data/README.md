# data/

本项目**不收录**真实会话数据。

原因是真实会话的标题里带着个人与第三方信息（学校、专业、项目名、老师姓名），即使去掉路径也不适合公开。本目录只说明口径，不提供原始快照。

## 统计口径

两个来源：

1. **线上**：`<DSH_HOME>/storages/session_projcache/sessions/*.json`，每条记录含 `tokenUsage.totals`（`outputTokens` / `cacheReadTokens` / `uncachedInputTokens`）、`sessionStats.val.steps`、`rows.agentPreset.val`。
2. **归档**：`<DSH_HOME>/dsh-session-cleaner/trash/meta/*.json`，`projcacheRow` 字段是一个 JSON 字符串，解析后与线上结构一致。

费用按 deepseek-flash 闲时价计算：缓存命中 0.003、未命中 0.15、输出 0.6（美元 / 百万 token）。

## 我们量到的东西（142 个会话）

| 项 | 线上 34 个 | 归档 107 个 | 合计 |
|---|---|---|---|
| 输出 token | 7.08M | 22.90M | 29.98M |
| 上下文重读 token | 1,118.5M | 3,473.8M | 4,592.3M |
| 未命中输入 token | 11.80M | 53.38M | 65.18M |
| 费用 | $9.37 | $32.17 | $41.54 |
| 费用占比（输出/重读/未命中） | 45% / 36% / 19% | 43% / 32% / 25% | 44% / 34% / 22% |

复算脚本在 `tools/`，把 `DSH_HOME` 指到自己的 home 即可：

```bash
DSH_HOME=/path/to/.dsh node tools/output-report.mjs
```
