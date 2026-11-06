import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createInitialState, readUsage } from '../metrics.js';
import { readRequestRate, recordFacts } from '../ui-metrics.js';

const metrics = { usageProvided: true, timingRecorded: true, outputTokens: 2000, stepStartTime: 1000, completedTime: 43000, firstTokenTime: 41000 };
const usage = { inputTokens: 10, outputTokens: 2000, reasoningTokens: 1800, totalTokens: 2010 };

test('request UI rejects malformed full accounting before reporting a rate', () => {
  for (const malformed of [
    { ...usage, inputTokens: Infinity },
    { ...usage, cacheReadTokens: -1 },
    { ...usage, cacheWriteTokens: 1.5 },
    { ...usage, reasoningTokens: NaN },
  ]) assert.equal(readRequestRate(metrics, { usage: malformed }).reason, 'invalid-usage');
  assert.equal(readRequestRate(metrics, { usage: null }).reason, 'missing-usage');
  assert.equal(readRequestRate(metrics, { usage: { inputTokens: 10, outputTokens: 2001 } }).reason, 'contradictory-usage');
  assert.equal(readRequestRate(metrics, { usage }).rate, 2000 / 42);
});

test('known billing contradictions are rejected by both the fold and request UI', () => {
  for (const bad of [
    { ...usage, reasoningTokens: 2001 },
    { ...usage, totalTokens: 2000 },
    { ...usage, cacheReadTokens: 100, totalTokens: 2010 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.equal(readUsage(bad).reason, 'contradictory-usage');
    const base = applyEvent(createInitialState(), { type: 'step/start', seq: 0, time: 1000, data: { turn: 1, step: 1 } });
    const folded = applyEvent(base, { type: 'assistant/message', seq: 1, time: 43000, data: {
      turn: 1, step: 1, usage: bad, stream: [], message: { role: 'assistant', source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'answer' }] },
    } });
    assert.equal(folded.view.latest.status, 'contradictory-usage');
    assert.equal(folded.view.timedSteps, 0);
    assert.equal(folded.view.excludedSteps, 1);
  }
});

test('trajectory scalar usage is restored without token estimation or double-counting reasoning', () => {
  const cell = { kind: 'message', assistantMetrics: metrics, input: 10, output: 2000, think: 1800, cacheRead: 0, cacheWrite: 0,
    sourceBlocks: [{ type: 'reasoning', content: 'summary' }, { type: 'text', content: 'answer' }] };
  const facts = recordFacts({ record: { cell } });
  assert.deepEqual(facts.usage, { inputTokens: 10, outputTokens: 2000, reasoningTokens: 1800, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(facts.hasOutput, true);
  assert.equal(readRequestRate(metrics, { ...facts }).rate, 2000 / 42);
  assert.equal(cell.output, 2000);
});

test('original model blocks establish a contradiction when their reported output is zero', () => {
  for (const block of [{ type: 'text', content: 'answer' }, { type: 'reasoning', content: 'summary' }, { type: 'text', text: 'answer' }, { type: 'tool-call', content: '{}' }]) {
    const zero = { ...metrics, outputTokens: 0 };
    const facts = recordFacts({ record: { cell: { kind: 'message', assistantMetrics: zero, input: 10, output: 0, sourceBlocks: [block] } } });
    assert.equal(facts.hasOutput, true);
    assert.equal(readRequestRate(zero, facts).reason, 'contradictory-usage');
  }
});

test('explicit canonical cell usage is checked instead of inferred projected fields', () => {
  const bad = { ...usage, inputTokens: Infinity };
  const facts = recordFacts({ assistant: { cell: { kind: 'message', assistantMetrics: metrics, usage: bad, input: 10, output: 2000 } } });
  assert.equal(facts.usage, bad);
  assert.equal(readRequestRate(metrics, facts).reason, 'invalid-usage');
});
