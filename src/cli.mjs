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
  let endMs = Infinity;
  let label;
  let scopeTitle = '今日总览';
  const todayStr = formatLocalDate(now.getTime());

  if (opts.session) {
    startMs = 0;
    label = `会话 ${opts.session}`;
    scopeTitle = '会话总览';
  } else if (opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    const [y, m, d] = opts.date.split('-').map(Number);
    startMs = new Date(y, m - 1, d).getTime();
    endMs = new Date(y, m - 1, d + 1).getTime() - 1;
    label = opts.date === todayStr ? `今日 (${opts.date})` : opts.date;
    scopeTitle = opts.date === todayStr ? '今日总览' : '当日总览';
  } else if (opts.week) {
    const day = now.getDay();
    const diffToMon = (day + 6) % 7;
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMon);
    startMs = mon.getTime();
    label = `本周 (${formatLocalDate(startMs)} ~ ${todayStr})`;
    scopeTitle = '本周总览';
  } else if (typeof opts.days === 'number' && opts.days > 0) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (opts.days - 1));
    startMs = start.getTime();
    label = `最近 ${opts.days} 天 (${formatLocalDate(startMs)} ~ ${todayStr})`;
    scopeTitle = `近${opts.days}天总览`;
  } else {
    startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1;
    label = `今日 (${todayStr})`;
    scopeTitle = '今日总览';
  }

  if (!fs.existsSync(convDir)) {
    return {
      label,
      scopeTitle,
      sessions: 0,
      totals: { gens: 0, prompt: 0, cacheRead: 0, inTok: 0, outTok: 0, cacheHitRatePct: 0 },
      byModel: [],
      byDay: [],
      topSessions: [],
      allSessions: []
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
    if (!opts.session && (mtimeMs < startMs || mtimeMs > endMs)) continue;

    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });
      const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      let sGens = 0;
      let sIn = 0;
      let sCW = 0;
      let sCR = 0;
      let sOut = 0;
      let lastCtx = 0;
      let lastMaxCtx = 0;
      const sessModels = new Map();
      const dayKey = formatLocalDate(mtimeMs);

      for (let i = 0; i < rows.length; i++) {
        const p = parseGenMetadataRow(rows[i]);
        if (!(p.ctx > 0 || p.outTok > 0 || p.inTok > 0 || p.cacheRead > 0)) continue;
        sGens++;
        sIn += p.inTok;
        sCW += p.cacheWrite;
        sCR += p.cacheRead;
        sOut += p.outTok;
        if (p.ctx > 0) lastCtx = p.ctx;
        if (p.maxCtx > 0) lastMaxCtx = p.maxCtx;
        const mName = p.modelName || '(unknown)';
        sessModels.set(mName, (sessModels.get(mName) || 0) + p.inTok + p.cacheWrite + p.cacheRead);
        addBucket(byModel, mName, p);
        addBucket(byDay, dayKey, p);
      }

      if (sGens > 0) {
        const cid = f.slice(0, -3);
        const prompt = sIn + sCW + sCR;
        const modelsUsed = Array.from(sessModels.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);
        const primaryModel = modelsUsed[0] || '(unknown)';
        const ctxLimit = lastMaxCtx || 256000;
        totGens += sGens;
        totIn += sIn;
        totCW += sCW;
        totCR += sCR;
        totOut += sOut;
        sessionList.push({
          id: cid,
          title: titleMap.get(cid) || '(无标题)',
          date: dayKey,
          mtimeMs,
          model: primaryModel,
          models: modelsUsed,
          gens: sGens,
          prompt,
          cacheRead: sCR,
          inTok: sIn,
          outTok: sOut,
          lastCtx,
          ctxLimit,
          ctxPct: ctxLimit > 0 ? Math.round((lastCtx / ctxLimit) * 100) : 0,
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
  const sortedByPrompt = [...sessionList].sort((a, b) => b.prompt - a.prompt);
  const sortedByRecent = [...sessionList].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return {
    label,
    scopeTitle,
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
    topSessions: sortedByPrompt.slice(0, 5),
    allSessions: sortedByRecent
  };
}

export function formatReport(stats) {
  const lines = [];
  const t = stats.totals;
  lines.push(`${stats.label}（${stats.sessions} 个会话，${t.gens} 次调用）`);
  lines.push(
    `总计: 输入 ${fmtTok(t.prompt)} | 缓存命中 ${fmtTok(t.cacheRead)} | 未命中 ${fmtTok(t.inTok)} | 输出 ${fmtTok(t.outTok)} | 命中率 ${t.cacheHitRatePct}%`
  );

  if (stats.byModel.length > 0) {
    const modelWidth = Math.max(...stats.byModel.map((m) => m.key.length), 12);
    lines.push('');
    lines.push('分模型:');
    for (const m of stats.byModel) {
      lines.push(
        `  ${m.key.padEnd(modelWidth)}  ${String(m.gens).padStart(4)}次  输入 ${fmtTok(m.prompt).padStart(8)}  命中 ${String(m.cacheHitRatePct.toFixed(1) + '%').padStart(6)}`
      );
    }
  }

  if (stats.byDay.length > 1) {
    lines.push('');
    lines.push('按天:');
    for (const d of stats.byDay) {
      lines.push(
        `  ${d.key}  ${String(d.gens).padStart(4)}次  输入 ${fmtTok(d.prompt).padStart(8)}  命中 ${String(d.cacheHitRatePct.toFixed(1) + '%').padStart(6)}`
      );
    }
  }

  if (stats.topSessions.length > 1) {
    lines.push('');
    lines.push('消耗 Top 会话:');
    for (const s of stats.topSessions) {
      lines.push(
        `  ${s.date}  输入 ${fmtTok(s.prompt).padStart(8)}  命中 ${String(s.cacheHitRatePct.toFixed(1) + '%').padStart(6)}  ${s.title.slice(0, 42)}`
      );
    }
  }

  return lines.join('\n');
}

function formatTimeLabel(ms, includeDate = false) {
  if (!ms) return includeDate ? '--/-- --:--' : '--:--';
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!includeDate) return hhmm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
}

function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    w +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

function padEndW(str, target) {
  const diff = target - displayWidth(str);
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

function padStartW(str, target) {
  const diff = target - displayWidth(str);
  return diff > 0 ? ' '.repeat(diff) + str : str;
}

function truncateW(str, maxW) {
  let w = 0;
  let out = '';
  for (const ch of str) {
    const cw = displayWidth(ch);
    if (w + cw > maxW) return out.trimEnd() + '…';
    out += ch;
    w += cw;
  }
  return out;
}

export function formatDashboard(stats, { color = false, columns = process.stdout.columns || 100 } = {}) {
  const t = stats.totals;
  const sessions = stats.allSessions || stats.topSessions || [];
  const bold = color ? '\x1b[1m' : '';
  const dim = color ? '\x1b[2m' : '';
  const cyan = color ? '\x1b[36m' : '';
  const green = color ? '\x1b[32m' : '';
  const yellow = color ? '\x1b[33m' : '';
  const reset = color ? '\x1b[0m' : '';

  const hitColor = (pct) => (!color ? '' : pct >= 85 ? green : pct >= 60 ? yellow : '\x1b[31m');
  const width = Math.max(80, Math.min(columns, 120));
  const rule = dim + '─'.repeat(width) + reset;

  const lines = [];
  lines.push(`${bold}${cyan}AGY 统计看板${reset}  ${dim}${stats.label}${reset}`);
  lines.push(rule);
  lines.push(
    `${bold}${stats.scopeTitle || '今日总览'}${reset}  会话数: ${bold}${stats.sessions}${reset}  调用: ${bold}${t.gens}${reset}  ` +
      `总输入: ${bold}${fmtTok(t.prompt)}${reset}  缓存命中: ${bold}${fmtTok(t.cacheRead)}${reset}  ` +
      `未命中: ${fmtTok(t.inTok)}  输出: ${fmtTok(t.outTok)}  ` +
      `命中率: ${hitColor(t.cacheHitRatePct)}${bold}${t.cacheHitRatePct}%${reset}`
  );

  if (stats.byModel.length > 0) {
    const modelWidth = Math.max(...stats.byModel.map((m) => m.key.length), 12);
    lines.push(`${bold}分模型汇总 (${stats.byModel.length})${reset}`);
    for (const m of stats.byModel) {
      lines.push(
        `  ${m.key.padEnd(modelWidth)}  ${String(m.gens).padStart(4)}次  输入 ${fmtTok(m.prompt).padStart(8)}  缓存 ${fmtTok(m.cacheRead).padStart(8)}  命中 ${hitColor(m.cacheHitRatePct)}${String(m.cacheHitRatePct.toFixed(1) + '%').padStart(6)}${reset}`
      );
    }
  }

  lines.push(rule);
  lines.push(`${bold}全部会话明细 (${sessions.length})${reset}`);

  if (sessions.length === 0) {
    lines.push(`  ${dim}(当前时间范围内无活跃会话)${reset}`);
    return lines.join('\n');
  }

  const multiDay = new Set(sessions.map((s) => s.date)).size > 1;
  const timeW = multiDay ? 11 : 5;
  const fixedW = 2 + timeW + 2 + 8 + 2 + 5 + 2 + 8 + 2 + 8 + 2 + 7 + 2 + 6 + 2 + 6 + 2;
  const titleMaxW = Math.max(16, width - fixedW);

  lines.push(
    `${dim}  ${padEndW('时间', timeW)}  ${padEndW('ID', 8)}  ${padStartW('调用', 5)}  ${padStartW('总输入', 8)}  ${padStartW('缓存', 8)}  ${padStartW('输出', 7)}  ${padStartW('命中率', 6)}  ${padStartW('上下文', 6)}  标题${reset}`
  );

  for (const s of sessions) {
    const tm = formatTimeLabel(s.mtimeMs, multiDay);
    const shortId = s.id.slice(0, 8);
    const calls = String(s.gens).padStart(5);
    const prompt = fmtTok(s.prompt).padStart(8);
    const cache = fmtTok(s.cacheRead).padStart(8);
    const out = fmtTok(s.outTok).padStart(7);
    const hitStr = `${s.cacheHitRatePct.toFixed(1)}%`.padStart(6);
    const ctxStr = `${s.ctxPct ?? 0}%`.padStart(6);
    const title = truncateW(s.title || '(无标题)', titleMaxW);
    const modelsText = (s.models && s.models.length > 0 ? s.models.join(', ') : s.model || '(unknown)');

    lines.push(
      `  ${tm}  ${dim}${shortId}${reset}  ${calls}  ${prompt}  ${cache}  ${out}  ${hitColor(s.cacheHitRatePct)}${hitStr}${reset}  ${ctxStr}  ${bold}${title}${reset}`
    );
    lines.push(`  ${' '.repeat(timeW)}  ${dim}└ 模型: ${modelsText}${reset}`);
  }

  return lines.join('\n');
}

export function parseCliArgs(argv) {
  const opts = { week: false, days: 0, date: '', session: '', json: false, help: false, dashboard: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'dashboard' || a === '--dashboard' || a === '--board' || a === '-b') opts.dashboard = true;
    else if (a === '--week' || a === '-w') opts.week = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--today' || a === '-t') {
      opts.week = false;
      opts.days = 0;
      opts.date = '';
    } else if ((a === '--date' || a === '-D') && i + 1 < argv.length) {
      opts.date = argv[++i];
    } else if ((a === '--days' || a === '-d') && i + 1 < argv.length) {
      opts.days = Math.max(1, parseInt(argv[++i], 10) || 1);
    } else if ((a === '--session' || a === '-s') && i + 1 < argv.length) {
      opts.session = argv[++i];
    }
  }
  return opts;
}

function shiftDateStr(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return formatLocalDate(new Date(y, m - 1, d + deltaDays).getTime());
}

function runInteractiveDashboard(initialOpts) {
  const todayStr = formatLocalDate(Date.now());
  let mode = initialOpts.week ? 'week' : 'day';
  let currentDate = initialOpts.date && /^\d{4}-\d{2}-\d{2}$/.test(initialOpts.date) ? initialOpts.date : todayStr;

  const render = () => {
    const queryOpts = mode === 'week' ? { ...initialOpts, week: true, date: '' } : { ...initialOpts, week: false, date: currentDate };
    const stats = collectStats(queryOpts);
    const body = formatDashboard(stats, { color: true });
    const navHint =
      '\n\x1b[2m────────────────────────────────────────────────────────────────────────────────────────────────────\n' +
      '操作: [← / h] 前一天   [→ / l] 后一天   [t] 今天   [w] 切换周/日   [r] 刷新   [q / Esc] 退出\x1b[0m';
    process.stdout.write('\x1b[2J\x1b[H' + body + navHint + '\n');
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?25l');

  const cleanup = () => {
    process.stdout.write('\x1b[?25h');
    try {
      process.stdin.setRawMode(false);
    } catch {}
    process.stdin.pause();
  };

  render();

  process.stdin.on('data', (key) => {
    if (key === 'q' || key === '\u0003' || key === '\u001b') {
      cleanup();
      process.exit(0);
    } else if (key === '\u001b[D' || key === 'h' || key === '[') {
      mode = 'day';
      currentDate = shiftDateStr(currentDate, -1);
      render();
    } else if (key === '\u001b[C' || key === 'l' || key === ']') {
      mode = 'day';
      const next = shiftDateStr(currentDate, 1);
      if (next <= todayStr) currentDate = next;
      render();
    } else if (key === 't' || key === 'T') {
      mode = 'day';
      currentDate = todayStr;
      render();
    } else if (key === 'w' || key === 'W') {
      mode = mode === 'week' ? 'day' : 'week';
      render();
    } else if (key === 'r' || key === 'R') {
      render();
    }
  });
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
        'Usage: agy-stats [dashboard] [options]',
        '',
        'Options:',
        '  -b, --board          Show dashboard (interactive in TTY: ←/→ switch date, w week/day, q quit)',
        '  -t, --today          Show today stats (default)',
        '  -D, --date <date>    Show stats for a specific date (YYYY-MM-DD)',
        '  -w, --week           Show this week stats (Mon ~ today)',
        '  -d, --days <N>       Show last N days stats',
        '  -s, --session <id>   Show a specific session (or "latest")',
        '      --json           Output raw JSON',
        '  -h, --help           Show help'
      ].join('\n')
    );
    process.exit(0);
  }
  if (opts.dashboard && !opts.json && process.stdin.isTTY && process.stdout.isTTY) {
    runInteractiveDashboard(opts);
  } else {
    const stats = collectStats(opts);
    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else if (opts.dashboard) {
      console.log(formatDashboard(stats, { color: Boolean(process.stdout.isTTY) }));
    } else {
      console.log(formatReport(stats));
    }
  }
}
