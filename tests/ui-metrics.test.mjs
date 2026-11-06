import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptSessionStats, readRequestRate, timingElementKind, recordFacts } from '../ui-metrics.js';

const MAX = Number.MAX_SAFE_INTEGER;
const requestMetrics = (overrides = {}) => ({
  usageProvided: true,
  timingRecorded: true,
  inputTokens: 10,
  outputTokens: 2000,
  stepStartTime: 1000,
  completedTime: 43_000,
  firstTokenTime: 41_000,
  ...overrides,
});
const sessionView = (overrides = {}) => ({
  totalOutputTokens: 2000,
  totalDurationMs: 42_000,
  timedSteps: 1,
  excludedSteps: 0,
  aggregateRate: 2000 / 42,
  latest: null,
  ...overrides,
});
const legacyStats = () => ({
  decodeTokens: 348,
  decodeMs: 1000,
  inputTokens: 12_345,
  outputTokens: 5432,
  modelMs: 80_000,
  toolMs: 10_000,
  ttftMs: 200,
  requestCount: 12,
  toolCallCount: 7,
  models: { 'model-a': { count: 8 } },
});
const approx = (actual, expected) => assert.ok(
  Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12,
  `expected ${actual} to be approximately ${expected}`,
);
const assertUnavailable = (result, reason) => {
  assert.equal(result.rate, null);
  assert.equal(result.reason, reason);
  assert.ok(result.durationMs === null || Number.isSafeInteger(result.durationMs));
};

test('session adapter replaces only both legacy rate inputs from one projection view', () => {
  const stats = Object.freeze(legacyStats());
  const view = Object.freeze(sessionView());
  const adapted = adaptSessionStats(stats, view);
  assert.notEqual(adapted, stats);
  assert.equal(adapted.decodeTokens, view.totalOutputTokens);
  assert.equal(adapted.decodeMs, view.totalDurationMs);
  for (const key of Object.keys(stats).filter((key) => !['decodeTokens', 'decodeMs'].includes(key))) {
    assert.equal(adapted[key], stats[key], `${key} must retain its original value/reference`);
  }
  assert.equal(stats.decodeTokens, 348, 'do not mutate existing renderer stats');
  assert.equal(stats.decodeMs, 1000);
  approx(adapted.decodeTokens / (adapted.decodeMs / 1000), 2000 / 42);
});

test('unknown, incomplete, or invalid projection views clear the old 348 TPS instead of falling back', () => {
  const invalidViews = [
    undefined,
    null,
    {},
    { totalOutputTokens: 2000 },
    { totalDurationMs: 42_000, timedSteps: 1 },
    sessionView({ totalOutputTokens: -1 }),
    sessionView({ totalOutputTokens: 1.5 }),
    sessionView({ totalOutputTokens: Infinity }),
    sessionView({ totalOutputTokens: MAX + 1 }),
    sessionView({ totalDurationMs: 0 }),
    sessionView({ totalDurationMs: -1 }),
    sessionView({ totalDurationMs: NaN }),
    sessionView({ totalDurationMs: MAX + 1 }),
    sessionView({ timedSteps: 0 }),
    sessionView({ timedSteps: 0.5 }),
    sessionView({ timedSteps: MAX + 1 }),
  ];
  for (const view of invalidViews) {
    const stats = legacyStats();
    const adapted = adaptSessionStats(stats, view);
    assert.equal(adapted.decodeTokens, 0, 'never retain numerator from the old accounting');
    assert.equal(adapted.decodeMs, 0, 'never retain denominator from the old accounting');
    assert.equal(adapted.inputTokens, stats.inputTokens);
    assert.equal(adapted.modelMs, stats.modelMs);
    assert.equal(adapted.models, stats.models);
  }
});

test('session adapter never mixes a valid numerator with an invalid denominator or vice versa', () => {
  const stats = legacyStats();
  for (const view of [
    sessionView({ totalOutputTokens: null }),
    sessionView({ totalDurationMs: null }),
  ]) {
    const adapted = adaptSessionStats(stats, view);
    assert.deepEqual([adapted.decodeTokens, adapted.decodeMs], [0, 0]);
  }
  assert.deepEqual(adaptSessionStats(null, null), { decodeTokens: 0, decodeMs: 0 });
  const zero = adaptSessionStats(stats, sessionView({ totalOutputTokens: 0, aggregateRate: 0 }));
  assert.equal(zero.decodeTokens, 0);
  assert.equal(zero.decodeMs, 42_000, 'a measured zero-token sample still has its real duration');
});

test('single-request adapter uses complete step-to-final time, never first-token time', () => {
  for (const firstTokenTime of [undefined, null, 1000, 41_000, 42_999, NaN, Infinity]) {
    const result = readRequestRate(requestMetrics({ firstTokenTime }));
    assert.equal(result.reason, null);
    assert.equal(result.durationMs, 42_000);
    approx(result.rate, 2000 / 42);
    assert.notEqual(result.rate, 1000);
  }
  const withPoisonedFirstToken = requestMetrics();
  Object.defineProperty(withPoisonedFirstToken, 'firstTokenTime', {
    get() { throw new Error('firstTokenTime must not be read'); },
  });
  assert.equal(readRequestRate(withPoisonedFirstToken).durationMs, 42_000);
});

test('pending, missing usage/start, or unrecorded request metrics are unavailable', () => {
  assertUnavailable(readRequestRate(null), 'missing-usage');
  assertUnavailable(readRequestRate(requestMetrics({ usageProvided: false })), 'missing-usage');
  for (const completedTime of [null, undefined]) {
    assertUnavailable(readRequestRate(requestMetrics({ completedTime })), 'pending');
  }
  for (const stepStartTime of [null, undefined]) {
    assertUnavailable(readRequestRate(requestMetrics({ stepStartTime })), 'missing-start');
  }
  assertUnavailable(readRequestRate(requestMetrics({ timingRecorded: false })), 'not-recorded');
});

test('failed or interrupted records are not counted as an effective final request', () => {
  for (const flags of [{ isError: true }, { interrupted: true }, { isError: true, interrupted: true }]) {
    const cell = { assistantMetrics: requestMetrics(), outputDetail: 'partial output', ...flags };
    const facts = recordFacts({ record: { cell } });
    assert.equal(facts.interrupted, true);
    assert.equal(facts.hasOutput, true);
    assertUnavailable(readRequestRate(facts.metrics, facts), 'interrupted');
  }
  assertUnavailable(readRequestRate(requestMetrics(), { interrupted: true }), 'interrupted');
});

test('zero tokens plus known model output is contradictory, not 0 TPS', () => {
  assertUnavailable(readRequestRate(requestMetrics({ outputTokens: 0 }), { hasOutput: true }), 'contradictory-usage');
  const empty = readRequestRate(requestMetrics({ outputTokens: 0 }), { hasOutput: false });
  assert.equal(empty.rate, 0);
  assert.equal(empty.durationMs, 42_000);
  assert.equal(empty.reason, null);
  assertUnavailable(readRequestRate(requestMetrics({ outputTokens: 0, completedTime: null }), { hasOutput: true }), 'pending');
});

test('single-request adapter preserves clock/usage/short-duration safeguards from the shared pure calculator', () => {
  for (const [overrides, reason, durationMs] of [
    [{ completedTime: 999 }, 'clock-regression', null],
    [{ completedTime: 1000 }, 'zero-duration', 0],
    [{ completedTime: 1099 }, 'too-short', 99],
    [{ completedTime: Infinity }, 'invalid-time', null],
    [{ outputTokens: MAX + 1 }, 'invalid-usage', 42_000],
    [{ outputTokens: -1 }, 'invalid-usage', 42_000],
  ]) {
    const result = readRequestRate(requestMetrics(overrides));
    assertUnavailable(result, reason);
    assert.equal(result.durationMs, durationMs);
  }
  const custom = readRequestRate(requestMetrics({ completedTime: 1200 }), { minDurationMs: 1000 });
  assertUnavailable(custom, 'too-short');
  assert.equal(custom.durationMs, 200, 'do not raise the interval to the configured minimum');
});

test('timing structure detection recognizes only the existing panel/table/record/request inputs', () => {
  assert.equal(timingElementKind({ metrics: requestMetrics() }), 'panel');
  assert.equal(timingElementKind({ turns: [], requestNumbers: [] }), 'table');
  assert.equal(timingElementKind({ record: { cell: { assistantMetrics: requestMetrics() } } }), 'record');
  assert.equal(timingElementKind({ assistant: { cell: { assistantMetrics: requestMetrics() } } }), 'record');
  assert.equal(timingElementKind({ assistant: null, anchor: null, request: null }), 'request');
});

test('tools, unrelated metrics, or arbitrary children are never treated as a timing panel', () => {
  const incomplete = requestMetrics();
  delete incomplete.usageProvided;
  const unrelated = [
    null,
    undefined,
    {},
    { children: 'anything' },
    { children: [{ props: { metrics: requestMetrics() } }] },
    { metrics: { durationMs: 1000, outputTokens: 100 } },
    { metrics: { executionMs: 1000, timingRecorded: true, completedTime: 2000 } },
    { metrics: incomplete },
    { tool: { name: 'read' }, result: 'tool output', children: [] },
    { record: { cell: { toolMetrics: { durationMs: 500 } } } },
    { turns: [] },
    { requestNumbers: [] },
    { turns: {}, requestNumbers: [] },
    Object.create({ assistant: null, anchor: null, request: null }),
  ];
  for (const props of unrelated) assert.equal(timingElementKind(props), null);
});

test('record facts carry their owning metrics and distinguish empty/text/reasoning/tool-call output', () => {
  for (const props of [null, undefined, {}, { record: {} }, { assistant: {} }]) {
    assert.equal(recordFacts(props), null);
  }
  const metrics = requestMetrics();
  for (const [fields, expected] of [
    [{}, false],
    [{ outputDetail: '', thinkingDetail: '', sourceBlocks: [] }, false],
    [{ outputDetail: 'answer' }, true],
    [{ outputDetail: ' ' }, true],
    [{ thinkingDetail: 'hidden reasoning' }, true],
    [{ sourceBlocks: [{ type: 'tool-call', name: 'read', arguments: '{}' }] }, true],
    [{ sourceBlocks: [{ type: 'text', text: '' }] }, false],
  ]) {
    const cell = { assistantMetrics: metrics, ...fields };
    const facts = recordFacts({ record: { cell } });
    assert.equal(facts.metrics, metrics);
    assert.equal(facts.interrupted, false);
    assert.equal(facts.hasOutput, expected);
    const assistantFacts = recordFacts({ assistant: { cell } });
    assert.equal(assistantFacts.metrics, metrics);
    assert.equal(assistantFacts.hasOutput, expected);
  }
  assert.equal(recordFacts({ record: { cell: {} } }).metrics, null);
});
