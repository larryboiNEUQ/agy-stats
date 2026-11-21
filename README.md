# agy-stats

Token usage & prompt cache hit rate **CLI (`agy-stats`)** and **`statusLine` plugin** for **Google Antigravity CLI (`agy`)**.

```text
# Terminal CLI
$ agy-stats
Today (2026-11-21)  (5 sessions, 1030 calls)
Total: Prompt 175.45M | CacheRead 155.17M | Uncached 20.28M | Out 1.04M | Hit 88.44%

By Model:
  Gemini 4 Hydrogen (High)          450x  Prompt   93.28M  Hit  89.9%
  Gemini 4 Hydrogen (Medium)        213x  Prompt   26.91M  Hit  87.7%
  ...

# agy TUI footer (statusLine)
Ctx 26% (134k/512k) | 本轮命中 96.6% | 本会话 5.51M (命中 90.9%) | 今日 175.45M (命中 88.4%)
```

## Requirements

- **Node.js >= 22.13.0** (uses built-in `node:sqlite`, zero external dependencies)
- **Antigravity CLI (`agy`)**

## Install

```bash
git clone https://github.com/larryboiNEUQ/agy-stats.git
cd agy-stats
node install.mjs install
```

This installs:
1. `agy-stats` CLI command to `~/.local/bin/agy-stats` (when `~/.local/bin` exists), or you can run `npm link`.
2. `statusLine` hook into `~/.gemini/antigravity-cli/settings.json` (`stack_with_default: true`).

## CLI Usage

```bash
agy-stats              # Today summary + by-model breakdown
agy-stats --week       # This week (Mon ~ today) + by-day + by-model
agy-stats --days 7     # Last 7 days
agy-stats -s latest    # Most recent session
agy-stats --json       # Raw JSON output
```

## Uninstall

```bash
node install.mjs uninstall
```

## Test

```bash
npm test
```

## Credits

- Protobuf `gen_metadata` schema & context/cache metrics logic adapted from [nkjDSLcvanv/antigravity-codex-theme](https://github.com/nkjDSLcvanv/antigravity-codex-theme) (MIT License).
- Built for [Google Antigravity CLI](https://antigravity.google/docs/cli/statusline).
