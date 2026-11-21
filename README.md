# agy-statusline

Custom `statusLine` plugin for **Google Antigravity CLI (`agy`)**, displaying real-time context window usage, per-turn / per-session / daily prompt totals, and prompt cache hit rates directly in the TUI footer.

```text
Ctx 21% (108k/512k) | 本轮命中 96.6% | 本会话 2.49M (命中 93.2%) | 今日 166.61M (命中 88.0%)
```

## Why?

`agy` CLI's `statusLine` `stdin` payload currently leaves `context_window.context_window_size` and `used_percentage` at `0`, and does not include session/daily aggregate cache hit rates.

This plugin aligns directly with the local SQLite + Protobuf metrics logic from [nkjDSLcvanv/antigravity-codex-theme](https://github.com/nkjDSLcvanv/antigravity-codex-theme):
- Reads `last.ctx` and the model's real `maxCtx` (`512k` / `256k` / `840k`, etc.) from `~/.gemini/antigravity-cli/conversations/<id>.db` (`gen_metadata` protobuf).
- Computes **per-turn**, **per-session**, and **today's** prompt cache hit rates (`cacheRead / (inTok + cacheWrite + cacheRead)`).
- Caches unchanged conversation `.db` files by `mtime + size` in the OS temp dir so warm refreshes complete in ~35ms (well within `agy`'s 5s timeout).
- Stacks cleanly below the built-in status bar (`stack_with_default: true`).

## Requirements

- **Node.js >= 22.13.0** (uses built-in `node:sqlite`, zero external dependencies)
- **Antigravity CLI (`agy`)**

## Install

```bash
git clone https://github.com/larryboiNEUQ/agy-statusline.git
cd agy-statusline
node install.mjs install
```

Start a new `agy` session (or run `/statusline enable` inside an active TUI session).

## Uninstall

```bash
node install.mjs uninstall
```

Or temporarily disable it inside `agy` with `/statusline disable`.

## Test

```bash
npm test
```

## Credits

- Protobuf `gen_metadata` schema & context/cache metrics logic adapted from [nkjDSLcvanv/antigravity-codex-theme](https://github.com/nkjDSLcvanv/antigravity-codex-theme) (MIT License).
- Built for [Google Antigravity CLI](https://antigravity.google/docs/cli/statusline).
