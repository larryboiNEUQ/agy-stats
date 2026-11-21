---
name: agy-stats
description: Check Google Antigravity CLI (agy) token usage, context window, and prompt cache hit rates (today, this week, last N days, or per-session, broken down by model). Use when the user asks about agy token consumption, cache hit rate, or session/daily/weekly usage stats.
---

# agy-stats

Query local Antigravity CLI conversation metrics (`~/.gemini/antigravity-cli/conversations/*.db`) via `agy-stats`.

## Commands

Prefer `agy-stats` if it is on `PATH`; otherwise run `node --no-warnings ~/.gemini/antigravity-cli/agy-stats-cli.mjs`.

- **Today (default)**: `agy-stats --json`
- **Dashboard (today overview + all sessions)**: `agy-stats dashboard` (or `agy-stats -b`)
- **This week (Mon ~ today)**: `agy-stats --week --json`
- **Last N days**: `agy-stats --days 7 --json`
- **Specific or latest session**: `agy-stats --session <conversation_id|latest> --json`

## Reporting

1. Lead with total `Prompt`, `CacheRead`, `Out`, and overall `cacheHitRatePct` (%).
2. Include the `byModel` breakdown when multiple models were used, noting any low-hit cold-start models separately.
3. For current TUI footer status, note that `agy` runs `~/.gemini/antigravity-cli/statusline.mjs` automatically via `statusLine` in `settings.json`.
