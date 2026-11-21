import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { computeStatusLine, fmtTok, formatContextLimitLabel } from '../src/statusline.mjs';

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

function buildGenMetadataBlob({ inTok, outTok, cacheWrite = 0, cacheRead, maxCtx }) {
  const usage = Buffer.concat([
    encodeFieldVarint(2, inTok),
    encodeFieldVarint(3, outTok),
    encodeFieldVarint(4, cacheWrite),
    encodeFieldVarint(5, cacheRead)
  ]);
  const ctxMeta = encodeFieldVarint(4, maxCtx);
  const chatStart = encodeFieldBytes(10, ctxMeta);
  const chat = Buffer.concat([encodeFieldBytes(4, usage), encodeFieldBytes(9, chatStart)]);
  return encodeFieldBytes(1, chat);
}

function createConvDb(dir, cid, rows, mtimeDate = null) {
  const dbPath = path.join(dir, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);');
  const stmt = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
  rows.forEach((r, idx) => stmt.run(idx, buildGenMetadataBlob(r)));
  db.close();
  if (mtimeDate) {
    fs.utimesSync(dbPath, mtimeDate, mtimeDate);
  }
  return dbPath;
}

test('fmtTok and formatContextLimitLabel format boundaries cleanly', () => {
  assert.equal(fmtTok(0), '0');
  assert.equal(fmtTok(149000), '149k');
  assert.equal(fmtTok(2490000), '2.49M');
  assert.equal(formatContextLimitLabel(256000), '256k');
  assert.equal(formatContextLimitLabel(512000), '512k');
  assert.equal(formatContextLimitLabel(1048576), '1M');
});

test('computeStatusLine aligns Ctx, turn, session, and today totals using gen_metadata', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-test-'));
  const cachePath = path.join(tmpDir, 'cache.json');
  const now = new Date(2026, 10, 21, 15, 30, 0);
  const yesterday = new Date(2026, 10, 20, 12, 0, 0);

  const cid1 = '11111111-1111-1111-1111-111111111111';
  const cid2 = '22222222-2222-2222-2222-222222222222';
  const cidOld = '33333333-3333-3333-3333-333333333333';

  createConvDb(tmpDir, cid1, [
    { inTok: 10000, outTok: 500, cacheRead: 90000, maxCtx: 512000 },
    { inTok: 3662, outTok: 400, cacheRead: 104029, maxCtx: 512000 }
  ], now);
  createConvDb(tmpDir, cid2, [
    { inTok: 50000, outTok: 1000, cacheRead: 450000, maxCtx: 256000 }
  ], now);
  createConvDb(tmpDir, cidOld, [
    { inTok: 999999, outTok: 1000, cacheRead: 999999, maxCtx: 256000 }
  ], yesterday);

  const line = computeStatusLine(
    {
      conversation_id: cid1,
      context_window: { context_window_size: 0, used_percentage: 0, current_usage: null }
    },
    { convDir: tmpDir, cachePath, now, color: false }
  );

  // cid1: lastCtx = 107691 (21% of 512k), turn = 104029/107691 = 96.6%
  // cid1 total: prompt = 207691 (208k), cacheRead = 194029 -> 93.4%
  // today (cid1 + cid2, excluding cidOld): prompt = 707691 (708k), cacheRead = 644029 -> 91.0%
  assert.equal(line, 'Ctx 21% (108k/512k) | 本轮命中 96.6% | 本会话 208k (命中 93.4%) | 今日 708k (命中 91.0%)');

  // Re-run to verify warm daily cache produces identical output
  const lineWarm = computeStatusLine(
    { conversation_id: cid1 },
    { convDir: tmpDir, cachePath, now, color: false }
  );
  assert.equal(lineWarm, line);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('computeStatusLine handles brand-new empty session cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-empty-'));
  const cachePath = path.join(tmpDir, 'cache.json');
  const line = computeStatusLine(
    { conversation_id: '', context_window: { context_window_size: 0, used_percentage: 0, current_usage: null } },
    { convDir: tmpDir, cachePath, color: false }
  );
  assert.equal(line, 'Ctx 0% (0/256k) | 本轮命中 -- | 本会话 0 (命中 --) | 今日 0 (命中 --)');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
