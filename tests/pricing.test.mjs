import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICING,
  estimateTokenCost,
  fmtUsd,
  getRatesForModel,
  parseGeminiPricingMarkdown
} from '../src/pricing.mjs';

test('parseGeminiPricingMarkdown extracts standard rates and scheduled dates', () => {
  const sample = `
## Gemini 4 Hydrogen  {% id="gemini-4-hydrogen" %}
### Standard
* Input price
  * $1.50
* Output price (including thinking tokens)
  * $7.50
* Context caching price
  * $0.075
### Batch
* Input price
  * $0.75

## Gemini 4 Carbon  {% id="gemini-4-carbon" %}
### Standard
* Input price
  * $2.00 through November 30, 2026.
  $4.00 starting December 1, 2026.
* Output price (including thinking tokens)
  * $10.00 through November 30, 2026.
  $20.00 starting December 1, 2026.
* Context caching price
  * $0.10 through November 30, 2026.
  $0.20 starting December 1, 2026.
`;
  const parsed = parseGeminiPricingMarkdown(sample);
  assert.deepEqual(parsed['Gemini 4 Hydrogen'].tiers[0], {
    input: 1.5,
    output: 7.5,
    cacheRead: 0.075
  });
  assert.equal(parsed['Gemini 4 Carbon'].tiers.length, 2);
  assert.equal(parsed['Gemini 4 Carbon'].tiers[0].input, 2.0);
  assert.equal(parsed['Gemini 4 Carbon'].tiers[1].input, 4.0);
});

test('getRatesForModel maps Antigravity display names and respects promo cutoff', () => {
  const nov22 = Date.parse('2026-11-22T12:00:00Z');
  const dec02 = Date.parse('2026-12-02T12:00:00Z');

  assert.equal(getRatesForModel('Gemini 4 Hydrogen (High)', DEFAULT_PRICING, nov22).input, 1.5);
  assert.equal(getRatesForModel('Orchestrator (Neon)', DEFAULT_PRICING, nov22).input, 3.0);
  assert.equal(getRatesForModel('Gemini Flash', DEFAULT_PRICING, nov22).input, 0.75);
  assert.equal(getRatesForModel('Orchestrator (Carbon)', DEFAULT_PRICING, nov22).input, 2.0);
  assert.equal(getRatesForModel('Orchestrator (Carbon)', DEFAULT_PRICING, dec02).input, 4.0);
  assert.equal(getRatesForModel('Claude Sonnet 5.5 (Medium)', DEFAULT_PRICING, nov22), null);
});

test('estimateTokenCost computes cost and cache savings accurately', () => {
  const nov22 = Date.parse('2026-11-22T12:00:00Z');
  // 1M uncached ($1.50) + 10M cacheRead ($0.75) + 1M out ($7.50) = $9.75
  // saved = 10M * ($1.50 - $0.075) = $14.25
  const est = estimateTokenCost(
    { modelName: 'Gemini 4 Hydrogen (High)', inTok: 1_000_000, cacheRead: 10_000_000, outTok: 1_000_000 },
    DEFAULT_PRICING,
    nov22
  );
  assert.equal(est.priced, true);
  assert.equal(fmtUsd(est.costUsd), '$9.75');
  assert.equal(fmtUsd(est.savedUsd), '$14.25');

  const unpriced = estimateTokenCost(
    { modelName: 'Claude Sonnet 5.5 (Medium)', inTok: 1000, cacheRead: 0, outTok: 100 },
    DEFAULT_PRICING,
    nov22
  );
  assert.equal(unpriced.priced, false);
  assert.equal(unpriced.costUsd, 0);
});
