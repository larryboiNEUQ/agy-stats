#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseGenMetadataRow } from './protobuf.mjs';
import { fmtTok } from './statusline.mjs';

function formatLocalDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDbMtimeMs(dbPath) {
  const st = fs.statSync(dbPath, { throwIfNoEntry: false });
  if (!st) return 0;
  const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
  return Math.max(st.mtimeMs, wst ? wst.mtimeMs : 0);
}

function readTitleMap(cliDir) {
  const map = new Map();
  const sumPath = path.join(cliDir, 'conversation_summaries.db');
  if (!fs.existsSync(sumPath)) return map;
  let db;
  try {
    db = new DatabaseSync(sumPath, { readOnly: true, timeout: 200 });
    const rows = db.prepare('SELECT conversation_id, title FROM conversation_summaries').all();
    for (const r of rows) {
      map.set(r.conversation_id, (r.title || '').replace(/\s+/g, ' ').trim());
    }
  } catch {
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return map;
}

function addBucket(map, key, row) {
  if (!map.has(key)) {
    map.set(key, { gens: 0, inTok: 0, cacheWrite: 0, cacheRead: 0, outTok: 0 });
  }
  const b = map.get(key);
  b.gens++;
  b.inTok += row.inTok;
  b.cacheWrite += row.cacheWrite;
  b.cacheRead += row.cacheRead;
  b.outTok += row.outTok;
}

function finalizeBuckets(map) {
  return Array.from(map.entries())
    .map(([key, v]) => {
      const prompt = v.inTok + v.cacheWrite + v.cacheRead;
      return {
        key,
        gens: v.gens,
        prompt,
        cacheRead: v.cacheRead,
        inTok: v.inTok,
        outTok: v.outTok,
        cacheHitRatePct: prompt > 0 ? Number(((v.cacheRead / prompt) * 100).toFixed(2)) : 0
      };
    })
    .sort((a, b) => b.prompt - a.prompt);
}

export function collectStats(opts = {}) {
  const cliDir =
    opts.cliDir ||
    process.env.AGY_CLI_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli');
  const convDir = opts.convDir || process.env.AGY_CONVERSATIONS_DIR || path.join(cliDir, 'conversations');
  const now = opts.now instanceof Date ? opts.now : new Date();

  let startMs;
  let label;
  if (opts.session) {
    startMs = 0;
    label = `Session ${opts.session}`;
  } else if (opts.week) {
    const day = now.getDay();
    const diffToMon = (day + 6) % 7;
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMon);
    startMs = mon.getTime();
    label = `This Week (${formatLocalDate(startMs)} ~ ${formatLocalDate(now.getTime())})`;
  } else if (typeof opts.days === 'number' && opts.days > 0) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (opts.days - 1));
    startMs = start.getTime();
    label = `Last ${opts.days} Days (${formatLocalDate(startMs)} ~ ${formatLocalDate(now.getTime())})`;
  } else {
    startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    label = `Today (${formatLocalDate(now.getTime())})`;
  }

  if (!fs.existsSync(convDir)) {
    return {
      label,
      sessions: 0,
      totals: { gens: 0, prompt: 0, cacheRead: 0, inTok: 0, outTok: 0, cacheHitRatePct: 0 },
      byModel: [],
      byDay: [],
      topSessions: []
    };
  }

  let files = fs.readdirSync(convDir).filter((f) => f.endsWith('.db'));
  if (opts.session === 'latest') {
    files.sort((a, b) => getDbMtimeMs(path.join(convDir, b)) - getDbMtimeMs(path.join(convDir, a)));
    files = files.slice(0, 1);
  } else if (opts.session) {
    files = files.filter((f) => f === `${opts.session}.db` || f.startsWith(opts.session));
  }

  const titleMap = readTitleMap(cliDir);
  const byModel = new Map();
  const byDay = new Map();
  const sessionList = [];
  let totGens = 0;
  let totIn = 0;
  let totCW = 0;
  let totCR = 0;
  let totOut = 0;

  for (const f of files) {
    const dbPath = path.join(convDir, f);
    const mtimeMs = getDbMtimeMs(dbPath);
    if (!opts.session && mtimeMs < startMs) continue;

    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      let sGens = 0;
      let sIn = 0;
      let sCW = 0;
      let sCR = 0;
      let sOut = 0;
      const dayKey = formatLocalDate(mtimeMs);

      for (let i = 0; i < rows.length; i++) {
        const p = parseGenMetadataRow(rows[i]);
        if (!(p.ctx > 0 || p.outTok > 0 || p.inTok > 0 || p.cacheRead > 0)) continue;
        sGens++;
        sIn += p.inTok;
        sCW += p.cacheWrite;
        sCR += p.cacheRead;
        sOut += p.outTok;
        addBucket(byModel, p.modelName || '(unknown)', p);
        addBucket(byDay, dayKey, p);
      }

      if (sGens > 0) {
        const cid = f.slice(0, -3);
        const prompt = sIn + sCW + sCR;
        totGens += sGens;
        totIn += sIn;
        totCW += sCW;
        totCR += sCR;
        totOut += sOut;
        sessionList.push({
          id: cid,
          title: titleMap.get(cid) || '(untitled)',
          date: dayKey,
          gens: sGens,
          prompt,
          cacheRead: sCR,
          outTok: sOut,
          cacheHitRatePct: prompt > 0 ? Number(((sCR / prompt) * 100).toFixed(1)) : 0
        });
      }
    } catch {
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  const totPrompt = totIn + totCW + totCR;
  return {
    label,
    sessions: sessionList.length,
    totals: {
      gens: totGens,
      prompt: totPrompt,
      cacheRead: totCR,
      inTok: totIn,
      outTok: totOut,
      cacheHitRatePct: totPrompt > 0 ? Number(((totCR / totPrompt) * 100).toFixed(2)) : 0
    },
    byModel: finalizeBuckets(byModel),
    byDay: finalizeBuckets(byDay).sort((a, b) => a.key.localeCompare(b.key)),
    topSessions: sessionList.sort((a, b) => b.prompt - a.prompt).slice(0, 5)
  };
}

export function formatReport(stats) {
  const lines = [];
  const t = stats.totals;
  lines.push(`${stats.label}  (${stats.sessions} sessions, ${t.gens} calls)`);
  lines.push(
    `Total: Prompt ${fmtTok(t.prompt)} | CacheRead ${fmtTok(t.cacheRead)} | Uncached ${fmtTok(t.inTok)} | Out ${fmtTok(t.outTok)} | Hit ${t.cacheHitRatePct}%`
  );

  if (stats.byModel.length > 0) {
    lines.push('');
    lines.push('By Model:');
    for (const m of stats.byModel) {
      lines.push(
        `  ${m.key.padEnd(32)} ${String(m.gens).padStart(4)}x  Prompt ${fmtTok(m.prompt).padStart(8)}  Hit ${String(m.cacheHitRatePct.toFixed(1) + '%').padStart(6)}`
      );
    }
  }

  if (stats.byDay.length > 1) {
    lines.push('');
    lines.push('By Day:');
    for (const d of stats.byDay) {
      lines.push(
        `  ${d.key}  ${String(d.gens).padStart(4)}x  Prompt ${fmtTok(d.prompt).padStart(8)}  Hit ${String(d.cacheHitRatePct.toFixed(1) + '%').padStart(6)}`
      );
    }
  }

  if (stats.topSessions.length > 1) {
    lines.push('');
    lines.push('Top Sessions:');
    for (const s of stats.topSessions) {
      lines.push(
        `  ${s.date}  Prompt ${fmtTok(s.prompt).padStart(8)}  Hit ${String(s.cacheHitRatePct.toFixed(1) + '%').padStart(6)}  ${s.title.slice(0, 42)}`
      );
    }
  }

  return lines.join('\n');
}

export function parseCliArgs(argv) {
  const opts = { week: false, days: 0, session: '', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--week' || a === '-w') opts.week = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--today' || a === '-t') {
      opts.week = false;
      opts.days = 0;
    } else if ((a === '--days' || a === '-d') && i + 1 < argv.length) {
      opts.days = Math.max(1, parseInt(argv[++i], 10) || 1);
    } else if ((a === '--session' || a === '-s') && i + 1 < argv.length) {
      opts.session = argv[++i];
    }
  }
  return opts;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        'Usage: agy-stats [options]',
        '',
        'Options:',
        '  -t, --today          Show today stats (default)',
        '  -w, --week           Show this week stats (Mon ~ today)',
        '  -d, --days <N>       Show last N days stats',
        '  -s, --session <id>   Show a specific session (or "latest")',
        '      --json           Output raw JSON',
        '  -h, --help           Show help'
      ].join('\n')
    );
    process.exit(0);
  }
  const stats = collectStats(opts);
  console.log(opts.json ? JSON.stringify(stats, null, 2) : formatReport(stats));
}
