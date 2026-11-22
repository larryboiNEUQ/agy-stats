import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { collectStats, formatDashboard, formatReport, parseCliArgs } from '../src/cli.mjs';

function encodeVarint(n) {
  const bytes = [];
  let v = n;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}
function encodeFieldVarint(fieldNum, val) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(val)]);
}
function encodeFieldBytes(fieldNum, buf) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}
function buildGenBlob({ inTok, outTok, cacheRead, maxCtx, modelName }) {
  const usage = Buffer.concat([
    encodeFieldVarint(2, inTok),
    encodeFieldVarint(3, outTok),
    encodeFieldVarint(5, cacheRead)
  ]);
  const ctxMeta = encodeFieldVarint(4, maxCtx);
  const chatStart = encodeFieldBytes(10, ctxMeta);
  const chat = Buffer.concat([
    encodeFieldBytes(4, usage),
    encodeFieldBytes(9, chatStart),
    encodeFieldBytes(21, Buffer.from(modelName, 'utf8'))
  ]);
  return encodeFieldBytes(1, chat);
}

test('parseCliArgs parses flags cleanly', () => {
  assert.deepEqual(parseCliArgs(['--week', '--json']), {
    week: true,
    days: 0,
    date: '',
    session: '',
    json: true,
    help: false,
    dashboard: false,
    syncPricing: false
  });
  assert.deepEqual(parseCliArgs(['dashboard', '-s', 'latest', '-d', '3', '-D', '2026-11-21']), {
    week: false,
    days: 3,
    date: '2026-11-21',
    session: 'latest',
    json: false,
    help: false,
    dashboard: true,
    syncPricing: false
  });
});

test('collectStats aggregates by model and filters by day/week/session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stats-cli-'));
  const convDir = path.join(tmpDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const now = new Date(2026, 10, 21, 15, 0, 0); // Saturday
  const monday = new Date(2026, 10, 16, 10, 0, 0);

  const db1 = new DatabaseSync(path.join(convDir, '11111111-1111-1111-1111-111111111111.db'));
  db1.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  db1.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(
    0,
    buildGenBlob({ inTok: 10000, outTok: 200, cacheRead: 90000, maxCtx: 512000, modelName: 'Gemini 4 Hydrogen (High)' })
  );
  db1.close();
  fs.utimesSync(path.join(convDir, '11111111-1111-1111-1111-111111111111.db'), now, now);

  const db2 = new DatabaseSync(path.join(convDir, '22222222-2222-2222-2222-222222222222.db'));
  db2.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  db2.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(
    0,
    buildGenBlob({ inTok: 50000, outTok: 300, cacheRead: 150000, maxCtx: 512000, modelName: 'Gemini 4 Neon (Medium)' })
  );
  db2.close();
  fs.utimesSync(path.join(convDir, '22222222-2222-2222-2222-222222222222.db'), monday, monday);
  // Simulate SQLite creating an empty 0-byte -wal file today on an older .db
  fs.writeFileSync(path.join(convDir, '22222222-2222-2222-2222-222222222222.db-wal'), '');
  fs.utimesSync(path.join(convDir, '22222222-2222-2222-2222-222222222222.db-wal'), now, now);

  const today = collectStats({ cliDir: tmpDir, convDir, now });
  assert.equal(today.sessions, 1);
  assert.equal(today.totals.prompt, 100000);
  assert.equal(today.totals.cacheHitRatePct, 90);
  assert.equal(today.byModel[0].key, 'Gemini 4 Hydrogen (High)');
  assert.equal(today.allSessions.length, 1);
  const board = formatDashboard(today, { color: false });
  assert.match(board, /AGY 统计看板/);
  assert.match(board, /全部会话明细 \(1\)/);
  assert.match(board, /Gemini 4 Hydrogen \(High\)/);
  assert.match(board, /11111111/);

  const week = collectStats({ cliDir: tmpDir, convDir, now, week: true });
  assert.equal(week.sessions, 2);
  assert.equal(week.totals.prompt, 300000);
  assert.equal(week.byModel.length, 2);
  assert.equal(week.byModel[0].key, 'Gemini 4 Hydrogen (High)');
  assert.equal(week.byModel[1].key, 'Gemini 4 Neon (Medium)');
  assert.match(formatReport(week), /分模型:/);
  assert.match(formatReport(week), /按天:/);

  const mondayOnly = collectStats({ cliDir: tmpDir, convDir, now, date: '2026-11-16' });
  assert.equal(mondayOnly.sessions, 1);
  assert.equal(mondayOnly.totals.prompt, 200000);
  assert.equal(mondayOnly.scopeTitle, '当日总览');

  const latest = collectStats({ cliDir: tmpDir, convDir, now, session: 'latest' });
  assert.equal(latest.sessions, 1);
  assert.equal(latest.byModel[0].key, 'Gemini 4 Hydrogen (High)');

  const helpRun = spawnSync(process.execPath, ['--no-warnings', path.resolve('src/cli.mjs'), '--help'], {
    encoding: 'utf8'
  });
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /Usage: agy-stats/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
