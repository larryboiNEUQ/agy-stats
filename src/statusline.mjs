#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseGenMetadataRow } from './protobuf.mjs';

const FALLBACK_CTX_LIMIT = 256000;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 10000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

export function formatContextLimitLabel(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0k';
  if (tokens >= 1000000) {
    if (tokens === 1000000 || tokens === 1048576) return '1M';
    return (tokens / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  }
  return Math.round(tokens / 1000) + 'k';
}

function getDbSig(dbPath) {
  const st = fs.statSync(dbPath, { throwIfNoEntry: false });
  if (!st) return null;
  const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
  const walSig = wst ? `${wst.mtimeMs}:${wst.size}` : '0:0';
  return {
    mtimeMs: Math.max(st.mtimeMs, wst ? wst.mtimeMs : 0),
    sig: `${st.mtimeMs}:${st.size}|${walSig}`
  };
}

export function readDbMetrics(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 150 });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    let inTok = 0;
    let cacheWrite = 0;
    let cacheRead = 0;
    let lastValid = null;
    let lastMaxCtx = 0;

    for (let i = 0; i < rows.length; i++) {
      const p = parseGenMetadataRow(rows[i]);
      inTok += p.inTok;
      cacheWrite += p.cacheWrite;
      cacheRead += p.cacheRead;
      if (p.maxCtx > 0) lastMaxCtx = p.maxCtx;
      if (p.ctx > 0 || p.outTok > 0) {
        lastValid = p;
      }
    }

    const prompt = inTok + cacheWrite + cacheRead;
    const lastCtx = lastValid ? lastValid.ctx : 0;
    const lastCacheRead = lastValid ? lastValid.cacheRead : 0;
    const contextLimit = (lastValid && lastValid.maxCtx > 0 ? lastValid.maxCtx : lastMaxCtx) || FALLBACK_CTX_LIMIT;

    return { prompt, cacheRead, lastCtx, lastCacheRead, contextLimit };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function computeStatusLine(data = {}, opts = {}) {
  const convDir =
    opts.convDir ||
    process.env.AGY_CONVERSATIONS_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
  const cachePath =
    opts.cachePath || path.join(os.tmpdir(), 'agy-statusline-daily-cache.json');
  const now = opts.now instanceof Date ? opts.now : new Date();
  const useColor = opts.color !== false;

  const cid = data.conversation_id || data.session_id || '';
  const sess = cid && UUID_RE.test(cid) ? readDbMetrics(path.join(convDir, `${cid}.db`)) : null;

  const cw = data.context_window || {};
  const cu = cw.current_usage;
  let lastCtx = sess ? sess.lastCtx : 0;
  let lastCacheRead = sess ? sess.lastCacheRead : 0;
  if (lastCtx === 0 && cu) {
    lastCtx = (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0);
    lastCacheRead = cu.cache_read_input_tokens || 0;
  }

  const ctxLimit = sess ? sess.contextLimit : cw.context_window_size > 0 ? cw.context_window_size : FALLBACK_CTX_LIMIT;
  const ctxPct = ctxLimit > 0 ? Math.round((lastCtx / ctxLimit) * 100) : 0;
  const ctxStr = `Ctx ${ctxPct}% (${fmtTok(lastCtx)}/${formatContextLimitLabel(ctxLimit)})`;

  const turnRateStr = lastCtx > 0 ? ((lastCacheRead / lastCtx) * 100).toFixed(1) + '%' : '--';

  const sessPrompt = sess ? sess.prompt : 0;
  const sessCacheRead = sess ? sess.cacheRead : 0;
  const sessRateStr = sessPrompt > 0 ? ((sessCacheRead / sessPrompt) * 100).toFixed(1) + '%' : '--';

  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  let cache = { date: todayKey, items: {} };
  try {
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (parsed && parsed.date === todayKey && parsed.items && typeof parsed.items === 'object') {
        cache = parsed;
      }
    }
  } catch {}

  let dayPrompt = 0;
  let dayCacheRead = 0;
  const nextItems = {};

  try {
    const files = fs.readdirSync(convDir);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.endsWith('.db')) continue;
      const id = f.slice(0, -3);
      const dbPath = path.join(convDir, f);
      const info = getDbSig(dbPath);
      if (!info || info.mtimeMs < todayStartMs) continue;

      let stats;
      const cached = cache.items[id];
      if (id === cid && sess && sess.prompt > 0) {
        stats = { prompt: sess.prompt, cacheRead: sess.cacheRead };
      } else if (
        cached &&
        cached.sig === info.sig &&
        typeof cached.prompt === 'number' &&
        typeof cached.cacheRead === 'number'
      ) {
        stats = cached;
      } else {
        const fresh = readDbMetrics(dbPath);
        if (fresh) stats = { prompt: fresh.prompt, cacheRead: fresh.cacheRead };
      }

      if (stats) {
        nextItems[id] = { sig: info.sig, prompt: stats.prompt, cacheRead: stats.cacheRead };
        dayPrompt += stats.prompt;
        dayCacheRead += stats.cacheRead;
      }
    }
    fs.writeFileSync(cachePath, JSON.stringify({ date: todayKey, items: nextItems }));
  } catch {}

  const dayRateStr = dayPrompt > 0 ? ((dayCacheRead / dayPrompt) * 100).toFixed(1) + '%' : '--';

  if (!useColor) {
    return `${ctxStr} | 本轮命中 ${turnRateStr} | 本会话 ${fmtTok(sessPrompt)} (命中 ${sessRateStr}) | 今日 ${fmtTok(dayPrompt)} (命中 ${dayRateStr})`;
  }

  const dim = '\x1b[2m';
  const cyan = '\x1b[36m';
  const green = '\x1b[32m';
  const reset = '\x1b[0m';

  return [
    `${cyan}${ctxStr}${reset}`,
    `本轮命中 ${green}${turnRateStr}${reset}`,
    `本会话 ${fmtTok(sessPrompt)} (命中 ${green}${sessRateStr}${reset})`,
    `今日 ${fmtTok(dayPrompt)} (命中 ${green}${dayRateStr}${reset})`
  ].join(` ${dim}|${reset} `);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let rawInput = '';
  try {
    rawInput = fs.readFileSync(0, 'utf8');
  } catch {}

  let data = {};
  try {
    if (rawInput.trim()) data = JSON.parse(rawInput);
  } catch {}

  process.stdout.write(computeStatusLine(data) + '\n');
}
