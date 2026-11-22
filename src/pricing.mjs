import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const GEMINI_PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing.md.txt';

// Snapshot from https://ai.google.dev/gemini-api/docs/pricing.md.txt (2026-11-22), USD per 1M tokens.
export const DEFAULT_PRICING = {
  source: GEMINI_PRICING_URL,
  syncedAt: '2026-11-22',
  models: {
    'Gemini 4 Neon': {
      tiers: [{ input: 3.0, output: 15.0, cacheRead: 0.15 }]
    },
    'Gemini 4 Hydrogen': {
      tiers: [{ input: 1.5, output: 7.5, cacheRead: 0.075 }]
    },
    'Gemini 4 Carbon': {
      tiers: [
        { until: '2026-11-30T23:59:59Z', input: 2.0, output: 10.0, cacheRead: 0.1 },
        { from: '2026-12-01T00:00:00Z', input: 4.0, output: 20.0, cacheRead: 0.2 }
      ]
    },
    'Gemini 4 Argon': {
      tiers: [
        { until: '2026-11-30T23:59:59Z', input: 2.0, output: 10.0, cacheRead: 0.1 },
        { from: '2026-12-01T00:00:00Z', input: 4.0, output: 20.0, cacheRead: 0.2 }
      ]
    },
    'Gemini 3.8 Flash': {
      tiers: [
        { until: '2026-12-31T23:59:59Z', input: 0.75, output: 3.75, cacheRead: 0.075 },
        { from: '2027-01-01T00:00:00Z', input: 1.5, output: 7.5, cacheRead: 0.15 }
      ]
    },
    'Gemini 3.6 Flash': {
      tiers: [{ input: 0.5, output: 3.0, cacheRead: 0.05 }]
    },
    'Gemini 3.1 Pro Preview': {
      tiers: [{ input: 2.0, output: 12.0, cacheRead: 0.2 }]
    },
    'Gemini 2.5 Pro': {
      tiers: [{ input: 1.25, output: 10.0, cacheRead: 0.125 }]
    },
    'Gemini 2.5 Flash': {
      tiers: [{ input: 0.3, output: 2.5, cacheRead: 0.03 }]
    }
  }
};

function extractBlockPrices(block) {
  const prices = [];
  for (const line of block.split(/\r?\n/)) {
    if (/storage price|1,000 requests|\/ 1,000/i.test(line)) continue;
    const m = line.match(/\$([0-9]+(?:\.[0-9]+)?)/);
    if (!m) continue;
    const val = Number(m[1]);
    if (!Number.isFinite(val)) continue;
    const through = line.match(/through\s+([A-Za-z]+\s+\d+,\s+\d{4})/i);
    const starting = line.match(/starting\s+([A-Za-z]+\s+\d+,\s+\d{4})/i);
    prices.push({
      val,
      until: through ? new Date(`${through[1]} 23:59:59 UTC`).toISOString() : undefined,
      from: starting ? new Date(`${starting[1]} 00:00:00 UTC`).toISOString() : undefined
    });
  }
  return prices;
}

export function parseGeminiPricingMarkdown(mdText) {
  const models = {};
  const sections = mdText.split(/^## /m).slice(1);
  const targetNames = Object.keys(DEFAULT_PRICING.models);

  for (const sec of sections) {
    const firstLine = sec.split(/\r?\n/, 1)[0] || '';
    const cleanTitle = firstLine.replace(/\{%.*?%\}/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
    if (!targetNames.includes(cleanTitle)) continue;

    const standardPart = sec.split(/^### Batch/m)[0] || sec;
    const inIdx = standardPart.indexOf('Input price');
    const outIdx = standardPart.indexOf('Output price');
    const cacheIdx = standardPart.indexOf('Context caching price');
    if (inIdx < 0 || outIdx < 0) continue;

    const inEnd = outIdx;
    const outEnd = cacheIdx > outIdx ? cacheIdx : standardPart.length;
    const afterCache = cacheIdx > 0 ? standardPart.slice(cacheIdx + 'Context caching price'.length) : '';
    const nextHeadingMatch = afterCache.match(/\n(?:#{2,3}\s|---|\s*\*\s+(?:Context caching storage|Grounding|Free|Paid|5,000|1,500|[A-Z][a-z]+ price))/);
    const cacheBlock = nextHeadingMatch ? afterCache.slice(0, nextHeadingMatch.index) : afterCache;

    const inPrices = extractBlockPrices(standardPart.slice(inIdx, inEnd));
    const outPrices = extractBlockPrices(standardPart.slice(outIdx, outEnd));
    const cachePrices = cacheIdx > 0 ? extractBlockPrices(cacheBlock) : [];

    if (inPrices.length === 0 || outPrices.length === 0) continue;
    const tiers = inPrices.map((ip, idx) => {
      const op = outPrices[idx] || outPrices[0];
      const cp = cachePrices[idx] || cachePrices[0];
      const tier = {
        input: ip.val,
        output: op.val,
        cacheRead: cp ? cp.val : Number((ip.val * 0.1).toFixed(4))
      };
      if (ip.until) tier.until = ip.until;
      if (ip.from) tier.from = ip.from;
      return tier;
    });
    models[cleanTitle] = { tiers };
  }

  return models;
}

export function getPricingPath(cliDir) {
  const dir = cliDir || process.env.AGY_CLI_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');
  return path.join(dir, 'agy-stats-pricing.json');
}

export function loadPricingTable(cliDir) {
  const filePath = getPricingPath(cliDir);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.models && typeof parsed.models === 'object') {
        return {
          ...DEFAULT_PRICING,
          ...parsed,
          models: { ...DEFAULT_PRICING.models, ...parsed.models }
        };
      }
    }
  } catch {}
  return DEFAULT_PRICING;
}

export async function syncPricingFromDocs(cliDir) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(GEMINI_PRICING_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const parsedModels = parseGeminiPricingMarkdown(text);
      if (Object.keys(parsedModels).length === 0) {
        throw new Error('No Gemini pricing sections parsed from docs');
      }
      const payload = {
        source: GEMINI_PRICING_URL,
        syncedAt: new Date().toISOString().slice(0, 10),
        models: { ...DEFAULT_PRICING.models, ...parsedModels }
      };
      const outPath = getPricingPath(cliDir);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
      return { outPath, count: Object.keys(parsedModels).length, payload };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export function resolveModelFamily(modelName) {
  if (!modelName) return null;
  const s = modelName.toLowerCase();
  if (s.includes('neon')) return 'Gemini 4 Neon';
  if (s.includes('hydrogen')) return 'Gemini 4 Hydrogen';
  if (s.includes('carbon')) return 'Gemini 4 Carbon';
  if (s.includes('argon')) return 'Gemini 4 Argon';
  if (s.includes('3.8') || s === 'gemini flash') return 'Gemini 3.8 Flash';
  if (s.includes('3.6')) return 'Gemini 3.6 Flash';
  if (s.includes('3.1 pro')) return 'Gemini 3.1 Pro Preview';
  if (s.includes('2.5 pro')) return 'Gemini 2.5 Pro';
  if (s.includes('2.5 flash')) return 'Gemini 2.5 Flash';
  return null;
}

export function getRatesForModel(modelName, pricingTable = DEFAULT_PRICING, atMs = Date.now()) {
  const models = pricingTable?.models || DEFAULT_PRICING.models;
  const direct = models[modelName];
  const family = direct ? modelName : resolveModelFamily(modelName);
  const entry = direct || (family ? models[family] : null);
  if (!entry || !Array.isArray(entry.tiers) || entry.tiers.length === 0) return null;

  for (const tier of entry.tiers) {
    const afterFrom = !tier.from || atMs >= Date.parse(tier.from);
    const beforeUntil = !tier.until || atMs <= Date.parse(tier.until);
    if (afterFrom && beforeUntil) return tier;
  }
  return entry.tiers[entry.tiers.length - 1];
}

export function estimateTokenCost(row, pricingTable = DEFAULT_PRICING, atMs = Date.now()) {
  const rates = getRatesForModel(row.modelName, pricingTable, atMs);
  if (!rates) return { costUsd: 0, savedUsd: 0, priced: false };

  const uncachedIn = (row.inTok || 0) + (row.cacheWrite || 0);
  const cacheRead = row.cacheRead || 0;
  const out = row.outTok || 0;

  const costUsd = (uncachedIn * rates.input + cacheRead * rates.cacheRead + out * rates.output) / 1e6;
  const savedUsd = (cacheRead * Math.max(0, rates.input - rates.cacheRead)) / 1e6;
  return { costUsd, savedUsd, priced: true };
}

export function fmtUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}
