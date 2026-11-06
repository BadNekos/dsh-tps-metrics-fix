import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config, PROJECTION_KEY } from '../index.js';

function definition(config = { enabled: true, minDurationMs: 100 }) {
  let captured;
  apply({ sessionProjections: { register(value) { captured = value; } } }, config);
  return captured;
}
const start = { type: 'step/start', seq: 0, time: 1000, data: { turn: 1, step: 1 } };
const response = { type: 'assistant/message', seq: 1, time: 43000, data: { turn: 1, step: 1,
  message: { role: 'assistant', source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'answer' }] },
  usage: { inputTokens: 10, outputTokens: 2000, reasoningTokens: 1800, totalTokens: 2010 }, stream: [],
} };

test('host module loads its real dependencies and validates configuration defaults', () => {
  assert.deepEqual(Config({}), { enabled: true, minDurationMs: 100 });
  for (const value of [0, -1, 1.5, 60001]) assert.throws(() => Config({ minDurationMs: value }));
  assert.equal(definition({ enabled: false, minDurationMs: 100 }), undefined);
});

test('registered projection validates initial, open, measured and checkpoint-restored states', () => {
  const unit = definition();
  assert.equal(unit.key, PROJECTION_KEY);
  let state = unit.init();
  unit.stateSchema.parse(state);
  state = unit.apply(state, start);
  unit.stateSchema.parse(state);
  state = unit.apply(state, response);
  const restored = unit.stateSchema.parse(JSON.parse(JSON.stringify(state)));
  const view = unit.wire.viewSchema.parse(unit.wire.view(restored));
  assert.equal(view.aggregateRate, 2000 / 42);
  assert.equal(view.latest.rate, 2000 / 42);
  assert.equal(view.latest.status, 'measured');
});

test('missing and malformed usage remain valid JSON projection outputs, not drive exceptions', () => {
  const unit = definition();
  for (const usage of [undefined, { inputTokens: Infinity, outputTokens: 2000 }, { inputTokens: 10, outputTokens: 0 }]) {
    const state = unit.apply(unit.apply(unit.init(), start), { ...response, data: { ...response.data, usage } });
    unit.stateSchema.parse(state);
    unit.wire.viewSchema.parse(unit.wire.view(state));
    assert.equal(state.view.latest.rate, null);
    assert.equal(state.view.timedSteps, 0);
  }
});

test('threshold changes use a different checkpoint version and never reuse old fold policy', () => {
  const first = definition({ enabled: true, minDurationMs: 100 });
  const second = definition({ enabled: true, minDurationMs: 200 });
  assert.notEqual(first.stateVersion, second.stateVersion);
  assert.equal(first.stateVersion, 1000100);
  assert.equal(second.stateVersion, 1000200);
});

test('wire views remain reference-stable on unrelated events and opening boundaries', () => {
  const unit = definition();
  const initial = unit.init();
  const opened = unit.apply(initial, start);
  assert.equal(unit.wire.view(initial), unit.wire.view(opened));
  const unchanged = unit.apply(opened, { type: 'tool/result', seq: 10, time: 9000, data: {} });
  assert.equal(unchanged, opened);
  assert.equal(unit.wire.view(initial), unit.wire.view(unchanged));
});
