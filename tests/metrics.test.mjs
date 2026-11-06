import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createInitialState, requestRate } from '../metrics.js';

const MAX = Number.MAX_SAFE_INTEGER;
const event = (type, time, data, seq) => ({ type, time, data, ...(seq === undefined ? {} : { seq }) });
const start = (time = 0, turn = 1, step = 1, seq) => event('step/start', time, { turn, step }, seq);
const end = (time = 2000, turn = 1, step = 1, seq) => event('step/end', time, { turn, step }, seq);
const turnEnd = (kind, time = 2000, turn = 1, seq) => event('turn/end', time, { turn, reason: { kind } }, seq);
const final = (time = 1000, {
  turn = 1,
  step = 1,
  outputTokens = 100,
  inputTokens = 10,
  content = [{ type: 'text', text: 'answer' }],
  stream = [],
  usage = { inputTokens, outputTokens },
  source = { kind: 'model', provider: 'test-provider', model: 'test-model' },
  interrupted,
  seq,
  ...extra
} = {}) => event('assistant/message', time, {
  turn,
  step,
  message: { role: 'assistant', source, content },
  stream,
  usage,
  ...(interrupted === undefined ? {} : { interrupted }),
  ...extra,
}, seq);
const fold = (events, initial = createInitialState(), options) => events.reduce(
  (state, item) => applyEvent(state, item, options), initial,
);
const approx = (actual, expected) => assert.ok(
  Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12,
  `expected ${actual} to be approximately ${expected}`,
);

function assertJsonSafe(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `not finite: ${value}`);
  if (Array.isArray(value)) value.forEach(assertJsonSafe);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(assertJsonSafe);
  else assert.notEqual(value, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

function afterPrevious(sampleStart, sampleFinal, options) {
  return fold([
    start(0, 1, 1),
    final(1000, { turn: 1, step: 1, outputTokens: 100 }),
    end(2000, 1, 1),
    sampleStart,
    sampleFinal,
  ].filter(Boolean), createInitialState(), options);
}

function assertExcluded(state, status, outputTokens = null, durationMs = null) {
  assert.equal(state.view.latest.status, status);
  assert.equal(state.view.latest.rate, null);
  assert.equal(state.view.latest.outputTokens, outputTokens);
  assert.equal(state.view.latest.durationMs, durationMs);
  assert.equal(state.view.timedSteps, 1);
  assert.equal(state.view.excludedSteps, 1);
  assert.equal(state.view.totalOutputTokens, 100);
  assert.equal(state.view.totalDurationMs, 1000);
  assert.equal(state.view.aggregateRate, 100);
  assertJsonSafe(state);
}

test('initial state is independent, plain JSON, with an empty stable view', () => {
  const left = createInitialState();
  const right = createInitialState();
  assert.deepEqual(left, {
    openStep: null,
    watermark: null,
    settledStep: null,
    view: {
      totalOutputTokens: 0,
      totalDurationMs: 0,
      timedSteps: 0,
      excludedSteps: 0,
      aggregateRate: null,
      latest: null,
    },
  });
  assert.notEqual(left, right);
  assert.notEqual(left.view, right.view);
  assertJsonSafe(left);
});

test('requestRate measures 40s hidden reasoning + 2s visible output as 47.619 E2E TPS, not 1000', () => {
  const result = requestRate(2000, 0, 42_000);
  assert.equal(result.durationMs, 42_000);
  assert.equal(result.reason, null);
  approx(result.rate, 47.61904761904762);
  assert.notEqual(result.rate, 1000);
});

test('late first delta and synthetic newlines cannot alter the committed request denominator', () => {
  const streams = [
    [],
    [{ type: 'text-chunks', time0: 40_000, index: 0, dt: [0, 2000], texts: ['answer', '\n'] }],
    [{ type: 'chunk', time: 41_999, chunk: { type: 'text-delta', index: 0, text: '\n' } }],
    [{ type: 'reasoning-chunks', time0: 5000, index: 0, dt: [0, 35_000], texts: ['think', 'done'] }],
  ];
  for (const stream of streams) {
    const state = fold([
      start(0),
      final(42_000, {
        stream,
        firstTokenTime: 41_999,
        usage: { inputTokens: 10, outputTokens: 2000, reasoningTokens: 1500, totalTokens: 2010 },
      }),
    ]);
    assert.equal(state.view.latest.status, 'measured');
    assert.equal(state.view.latest.durationMs, 42_000);
    assert.equal(state.view.latest.outputTokens, 2000);
    assert.equal(state.view.latest.reasoningTokens, 1500);
    assert.equal(state.view.totalOutputTokens, 2000, 'reasoning is already part of API output');
    approx(state.view.latest.rate, 2000 / 42);
    approx(state.view.aggregateRate, 2000 / 42);
  }
});

test('retry wait and partial attempts stay in one logical duration, counted only at successful final usage', () => {
  const state = fold([
    start(0, 1, 1, 0),
    event('assistant/attempt', 8000, { turn: 1, step: 1, stream: [
      { type: 'chunk', time: 7500, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 900 } } },
    ] }, 1),
    event('llm/retry-started', 9000, { turn: 1, step: 1 }, 2),
    event('llm/retry', 12_000, { turn: 1, step: 1 }, 3),
    start(15_000, 1, 1, 4), // Duplicate logical boundary must not reset its origin.
    event('assistant/attempt', 25_000, { turn: 1, step: 1, stream: [] }, 5),
    final(40_000, { outputTokens: 500, seq: 6 }),
  ]);
  assert.equal(state.openStep.startTime, 0);
  assert.equal(state.openStep.settled, true);
  assert.equal(state.view.latest.durationMs, 40_000);
  assert.equal(state.view.totalOutputTokens, 500);
  assert.equal(state.view.totalDurationMs, 40_000);
  assert.equal(state.view.timedSteps, 1);
  assert.equal(state.view.excludedSteps, 0);
  assert.equal(state.view.latest.rate, 12.5);
});

test('tool execution and step/end after the final message do not extend the duration or publish a new view', () => {
  const measured = fold([start(0, 1, 1, 0), final(1000, { seq: 1 })]);
  const tool = event('tool/result', 400_000, { turn: 1, step: 1, message: { role: 'tool' } }, 2);
  assert.equal(applyEvent(measured, tool), measured);
  const ended = applyEvent(measured, end(500_000, 1, 1, 3));
  assert.notEqual(ended, measured);
  assert.equal(ended.openStep, null);
  assert.equal(ended.view, measured.view);
  assert.equal(ended.view.latest.durationMs, 1000);
  assert.equal(ended.view.aggregateRate, 100);
});

test('session TPS is sum(tokens)/sum(seconds), not an unweighted average of step TPS', () => {
  const state = fold([
    start(0, 1, 1),
    final(1000, { turn: 1, step: 1, outputTokens: 100 }),
    end(8000, 1, 1),
    start(10_000, 1, 2),
    final(19_000, { turn: 1, step: 2, outputTokens: 90 }),
  ]);
  assert.equal(state.view.totalOutputTokens, 190);
  assert.equal(state.view.totalDurationMs, 10_000);
  assert.equal(state.view.timedSteps, 2);
  assert.equal(state.view.aggregateRate, 19);
  assert.equal(state.view.latest.rate, 10);
  assert.notEqual(state.view.aggregateRate, (100 + 10) / 2);
});

test('missing usage excludes the new sample and clears the previous request rate', () => {
  const missing = final(3000, { turn: 1, step: 2 });
  delete missing.data.usage;
  const state = afterPrevious(start(2000, 1, 2), missing);
  assertExcluded(state, 'missing-usage', null, 1000);
  assert.equal(state.view.latest.step, 2);
});

test('invalid required/optional API usage is rejected without unsafe values in state', async (t) => {
  const invalidCases = [
    ['negative output', { inputTokens: 10, outputTokens: -1 }],
    ['fractional output', { inputTokens: 10, outputTokens: 1.5 }],
    ['NaN output', { inputTokens: 10, outputTokens: NaN }],
    ['Infinity output', { inputTokens: 10, outputTokens: Infinity }],
    ['unsafe output', { inputTokens: 10, outputTokens: MAX + 1 }],
    ['string output', { inputTokens: 10, outputTokens: '100' }],
    ['missing input', { outputTokens: 50 }],
    ['negative input', { inputTokens: -1, outputTokens: 50 }],
    ['unsafe input', { inputTokens: MAX + 1, outputTokens: 50 }],
    ['invalid reasoning', { inputTokens: 10, outputTokens: 50, reasoningTokens: Infinity }],
    ['invalid total', { inputTokens: 10, outputTokens: 50, totalTokens: NaN }],
    ['invalid cache read', { inputTokens: 10, outputTokens: 50, cacheReadTokens: -1 }],
    ['invalid cache write', { inputTokens: 10, outputTokens: 50, cacheWriteTokens: MAX + 1 }],
    ['null optional', { inputTokens: 10, outputTokens: 50, reasoningTokens: null }],
  ];
  for (const [label, usage] of invalidCases) {
    await t.test(label, () => {
      const state = afterPrevious(start(2000, 1, 2), final(3000, { turn: 1, step: 2, usage }));
      const safeOutput = Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0
        ? usage.outputTokens : null;
      assertExcluded(state, 'invalid-usage', safeOutput, 1000);
    });
  }
});

test('zero output conflicting with text, reasoning, or tool-call content is not 0 TPS', async (t) => {
  for (const content of [
    [{ type: 'text', text: 'visible' }],
    [{ type: 'text', text: ' ' }],
    [{ type: 'reasoning', text: 'hidden' }],
    [{ type: 'tool-call', id: 'call-1', name: 'tool', arguments: '{}' }],
  ]) {
    await t.test(JSON.stringify(content), () => {
      const state = afterPrevious(start(2000, 1, 2), final(3000, {
        turn: 1, step: 2, outputTokens: 0, content,
      }));
      assertExcluded(state, 'contradictory-usage', 0, 1000);
    });
  }
});

test('zero output with nonzero reasoning usage is contradictory even with no visible content', () => {
  const state = afterPrevious(start(2000, 1, 2), final(3000, {
    turn: 1, step: 2, content: [], usage: { inputTokens: 10, outputTokens: 0, reasoningTokens: 1 },
  }));
  assertExcluded(state, 'contradictory-usage', 0, 1000);
});

test('a genuinely empty zero-output completed response is a measurable 0 TPS sample', () => {
  const state = fold([start(0), final(1000, { outputTokens: 0, content: [] })]);
  assert.equal(state.view.latest.status, 'measured');
  assert.equal(state.view.latest.rate, 0);
  assert.equal(state.view.aggregateRate, 0);
  assert.equal(state.view.totalOutputTokens, 0);
  assert.equal(state.view.totalDurationMs, 1000);
  assert.equal(state.view.timedSteps, 1);
});

test('missing or mismatched step/start clears latest TPS instead of reusing another step origin', () => {
  const state = afterPrevious(null, final(3000, { turn: 1, step: 2, outputTokens: 50 }));
  assertExcluded(state, 'missing-start', 50, null);
  const mismatched = fold([start(0, 1, 1), final(1000, { turn: 1, step: 2 })]);
  assert.equal(mismatched.view.latest.status, 'missing-start');
  assert.equal(mismatched.view.latest.rate, null);
  assert.equal(mismatched.view.totalOutputTokens, 0);
  assert.equal(mismatched.openStep.step, 1, 'do not borrow or discard a different step boundary');
});

test('invalid start timestamp is normalized to JSON null and marked invalid-time, not a guessed origin', () => {
  const state = afterPrevious(start(NaN, 1, 2), final(3000, { turn: 1, step: 2, outputTokens: 50 }));
  assert.equal(state.openStep.startTime, null);
  assertExcluded(state, 'invalid-time', 50, null);
});

test('invalid completion clocks are unmeasurable and JSON safe', async (t) => {
  for (const time of [NaN, Infinity, -Infinity, MAX + 1, 0.5, undefined, null, '3000']) {
    await t.test(String(time), () => {
      const state = afterPrevious(start(2000, 1, 2), final(time, { turn: 1, step: 2, outputTokens: 50 }));
      // Passing undefined to final uses its default: explicitly restore the malformed clock.
      if (time === undefined) {
        const bad = final(3000, { turn: 1, step: 2, outputTokens: 50 });
        bad.time = undefined;
        assertExcluded(afterPrevious(start(2000, 1, 2), bad), 'invalid-time', 50, null);
      } else {
        assertExcluded(state, 'invalid-time', 50, null);
      }
    });
  }
});

test('clock regression and zero duration are not clamped or retained as a previous valid rate', () => {
  assert.deepEqual(requestRate(50, 2000, 1999), {
    rate: null, durationMs: null, reason: 'clock-regression',
  });
  assert.deepEqual(requestRate(50, 2000, 2000), {
    rate: null, durationMs: 0, reason: 'zero-duration',
  });
  assertExcluded(afterPrevious(start(2000, 1, 2), final(1999, { turn: 1, step: 2, outputTokens: 50 })),
    'clock-regression', 50, null);
  assertExcluded(afterPrevious(start(2000, 1, 2), final(2000, { turn: 1, step: 2, outputTokens: 50 })),
    'zero-duration', 50, 0);
});

test('default 100ms threshold excludes 99ms unchanged and accepts exactly 100ms', () => {
  assert.deepEqual(requestRate(10, 0, 99), { rate: null, durationMs: 99, reason: 'too-short' });
  assert.deepEqual(requestRate(10, 0, 100), { rate: 100, durationMs: 100, reason: null });
  assertExcluded(afterPrevious(start(2000, 1, 2), final(2099, { turn: 1, step: 2, outputTokens: 50 })),
    'too-short', 50, 99);
});

test('custom duration minimum applies to requests and fold; there is no rate upper clamp', () => {
  assert.deepEqual(requestRate(100, 0, 200, 1000), { rate: null, durationMs: 200, reason: 'too-short' });
  const state = fold([start(0), final(200, { outputTokens: 100 })], createInitialState(), { minDurationMs: 1000 });
  assert.equal(state.view.latest.status, 'too-short');
  assert.equal(state.view.latest.durationMs, 200);
  assert.equal(state.view.timedSteps, 0);
  assert.equal(requestRate(100, 0, 1, 0).rate, 100_000);
  assert.equal(requestRate(100, 0, 0, 0).reason, 'zero-duration');
});

test('invalid duration minimum is explicit, never silently replaced or clamped', () => {
  for (const minimum of [-1, NaN, Infinity, 1.5, MAX + 1, null, '100']) {
    assert.deepEqual(requestRate(100, 0, 1000, minimum), {
      rate: null, durationMs: 1000, reason: 'invalid-min-duration',
    });
    const state = fold([start(0), final(1000)], createInitialState(), { minDurationMs: minimum });
    assert.equal(state.view.latest.status, 'invalid-min-duration');
    assertJsonSafe(state);
  }
});

test('safe integer boundary token count is allowed without output*1000 overflow or a TPS ceiling', () => {
  const result = requestRate(MAX, 0, 100);
  assert.equal(result.reason, null);
  assert.ok(Number.isFinite(result.rate));
  assert.ok(result.rate > MAX);
  const state = fold([start(0), final(100, { inputTokens: 0, outputTokens: MAX, content: [] })]);
  assert.equal(state.view.totalOutputTokens, MAX);
  assert.equal(state.view.timedSteps, 1);
  assertJsonSafe(state);
});

test('unsafe duration subtraction is excluded, not stored as an imprecise integer', () => {
  assert.deepEqual(requestRate(100, -MAX, MAX), {
    rate: null, durationMs: null, reason: 'duration-overflow',
  });
  const state = afterPrevious(start(-MAX, 1, 2), final(MAX, { turn: 1, step: 2, outputTokens: 50 }));
  assertExcluded(state, 'duration-overflow', 50, null);
});

test('aggregate token overflow excludes the entire newest sample while keeping safe paired totals', () => {
  const state = fold([
    start(0, 1, 1),
    final(1000, { turn: 1, step: 1, inputTokens: 0, outputTokens: MAX, content: [] }),
    end(1500, 1, 1),
    start(2000, 1, 2),
    final(3000, { turn: 1, step: 2, outputTokens: 1 }),
  ]);
  assert.equal(state.view.latest.status, 'aggregate-overflow');
  assert.equal(state.view.latest.rate, null);
  assert.equal(state.view.latest.outputTokens, 1);
  assert.equal(state.view.latest.durationMs, 1000);
  assert.equal(state.view.totalOutputTokens, MAX);
  assert.equal(state.view.totalDurationMs, 1000, 'do not add only the duration side');
  assert.equal(state.view.timedSteps, 1);
  assert.equal(state.view.excludedSteps, 1);
  assert.equal(state.view.aggregateRate, MAX);
  assertJsonSafe(state);
});

test('aggregate duration overflow excludes tokens and duration together', () => {
  const state = fold([
    start(-MAX, 1, 1),
    final(0, { turn: 1, step: 1, outputTokens: 100 }),
    end(1, 1, 1),
    start(1000, 1, 2),
    final(1100, { turn: 1, step: 2, outputTokens: 50 }),
  ]);
  assert.equal(state.view.latest.status, 'aggregate-overflow');
  assert.equal(state.view.totalDurationMs, MAX);
  assert.equal(state.view.totalOutputTokens, 100);
  assert.equal(state.view.timedSteps, 1);
  assert.equal(state.view.excludedSteps, 1);
  assertJsonSafe(state);
});

test('counter overflows are explicit and cannot emit unsafe counts', () => {
  const timed = createInitialState();
  timed.view.timedSteps = MAX;
  const timedResult = fold([start(0), final(1000)], timed);
  assert.equal(timedResult.view.latest.status, 'aggregate-overflow');
  assert.equal(timedResult.view.timedSteps, MAX);
  assert.equal(timedResult.view.totalOutputTokens, 0);
  assert.equal(timedResult.view.totalDurationMs, 0);
  assert.equal(timedResult.view.excludedSteps, 1);
  assertJsonSafe(timedResult);

  const excluded = createInitialState();
  excluded.view.excludedSteps = MAX;
  const excludedResult = fold([start(0), end(1000)], excluded);
  assert.equal(excludedResult.view.latest.status, 'counter-overflow');
  assert.equal(excludedResult.view.excludedSteps, MAX);
  assert.equal(excludedResult.view.latest.rate, null);
  assertJsonSafe(excludedResult);
});

test('interrupted final messages are excluded even with valid usage and visible content', () => {
  const state = afterPrevious(start(2000, 1, 2), final(3000, {
    turn: 1, step: 2, outputTokens: 50, interrupted: true,
  }));
  assertExcluded(state, 'interrupted', 50, 1000);
  const aborted = applyEvent(state, turnEnd('aborted', 5000));
  assertExcluded(aborted, 'cancelled', 50, 1000);
  assert.equal(aborted.view.excludedSteps, state.view.excludedSteps, 'refinement is not another settlement');
});

test('cancelled, failed, interrupted, or completed-without-response turns never become timed samples', async (t) => {
  const kinds = [
    ['aborted', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['error', 'failed'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['completed', 'no-response'],
    ['blocked', 'no-response'],
    ['forked', 'no-response'],
  ];
  for (const [kind, status] of kinds) {
    await t.test(kind, () => {
      const state = fold([
        start(0),
        event('assistant/attempt', 500, { turn: 1, step: 1, stream: [] }),
        turnEnd(kind, 2000),
      ]);
      assert.equal(state.openStep, null);
      assert.equal(state.view.latest.status, status);
      assert.equal(state.view.latest.rate, null);
      assert.equal(state.view.latest.durationMs, null, 'there was no final response timestamp');
      assert.equal(state.view.latest.outputTokens, null);
      assert.equal(state.view.timedSteps, 0);
      assert.equal(state.view.excludedSteps, 1);
      assert.equal(state.view.aggregateRate, null);
      assertJsonSafe(state);
    });
  }
});

test('step/end no-response is refined by turn/end once, without reading a nonexistent step/end reason', () => {
  const ended = fold([start(0, 1, 1, 0), end(1000, 1, 1, 1)]);
  assert.equal(ended.view.latest.status, 'no-response');
  assert.equal(ended.view.excludedSteps, 1);
  const cancelled = applyEvent(ended, turnEnd('aborted', 2000, 1, 2));
  assert.equal(cancelled.view.latest.status, 'cancelled');
  assert.equal(cancelled.view.excludedSteps, 1);
  assert.equal(applyEvent(cancelled, turnEnd('aborted', 2000, 1, 2)), cancelled);
});

test('later tool/turn failure does not revoke an already completed effective assistant response', () => {
  const measured = fold([start(0), final(1000)]);
  const failed = applyEvent(measured, turnEnd('error', 50_000));
  assert.equal(failed.view, measured.view);
  assert.equal(failed.view.latest.status, 'measured');
  assert.equal(failed.view.latest.durationMs, 1000);
  assert.equal(failed.view.timedSteps, 1);
  assert.equal(failed.view.excludedSteps, 0);
});

test('starting a different step settles an unfinished predecessor exactly once as no-response', () => {
  const state = fold([start(0, 1, 1), start(2000, 1, 2), final(3000, { turn: 1, step: 2 })]);
  assert.equal(state.view.timedSteps, 1);
  assert.equal(state.view.excludedSteps, 1);
  assert.equal(state.view.totalOutputTokens, 100);
  assert.equal(state.view.totalDurationMs, 1000);
  assert.equal(state.view.latest.step, 2);
});

test('unrelated events and malformed identities preserve the exact state/view reference', () => {
  const state = fold([start(0, 1, 1, 0)]);
  for (const item of [
    event('user/message', 10, { content: [] }, 1),
    event('developer/message', 20, { turn: 1, step: 1 }, 2),
    event('assistant/attempt', 30, { turn: 1, step: 1, stream: [] }, 3),
    event('llm/retry', 40, { turn: 1, step: 1 }, 4),
    event('llm/retry-started', 50, { turn: 1, step: 1 }, 5),
    event('tool/call', 60, { turn: 1, step: 1 }, 6),
    event('session/end-seed', 70, {}, 7),
    event('plugin:other', 80, {}, 8),
    event('step/start', 90, { turn: NaN, step: 2 }, 9),
    event('assistant/message', 100, { turn: 1, step: Infinity }, 10),
    event('step/end', 110, { turn: 1, step: 999 }, 11),
    event('turn/end', 120, { turn: 999, reason: { kind: 'completed' } }, 12),
    null,
    {},
  ]) {
    assert.equal(applyEvent(state, item), state);
    assert.equal(applyEvent(state, item).view, state.view);
  }
});

test('opening a step only changes internal state and retains the same wire view', () => {
  const state = createInitialState();
  const opened = applyEvent(state, start(1000, 1, 1, 0));
  assert.notEqual(opened, state);
  assert.equal(opened.view, state.view);
  assert.equal(opened.openStep.startTime, 1000);
  assert.equal(opened.watermark, 0);
  assert.equal(state.openStep, null, 'apply is immutable');
  assert.equal(applyEvent(opened, start(5000, 1, 1, 1)), opened);
});

test('duplicate final settlement is ignored with and without seq, including after step/end', () => {
  for (const seq of [undefined, 1]) {
    const response = final(1000, { seq });
    const state = fold([start(0, 1, 1, seq === undefined ? undefined : 0), response]);
    assert.equal(applyEvent(state, response), state);
    const ended = applyEvent(state, end(2000, 1, 1, seq === undefined ? undefined : 2));
    assert.equal(applyEvent(ended, response), ended);
    assert.equal(applyEvent(ended, start(0, 1, 1, seq === undefined ? undefined : 0)), ended);
    assert.equal(ended.view.timedSteps, 1);
    assert.equal(ended.view.totalOutputTokens, 100);
  }
});

test('ordered replay and JSON checkpoint/tail restore produce identical state', () => {
  const events = [
    start(0, 1, 1, 0),
    event('assistant/attempt', 5000, { turn: 1, step: 1, stream: [] }, 1),
    final(10_000, { outputTokens: 200, seq: 2 }),
    end(50_000, 1, 1, 3),
    turnEnd('completed', 51_000, 1, 4),
    start(60_000, 2, 1, 5),
    final(61_000, { turn: 2, step: 1, outputTokens: 100, seq: 6 }),
    end(62_000, 2, 1, 7),
    turnEnd('completed', 63_000, 2, 8),
  ];
  const uninterrupted = fold(events);
  assert.deepEqual(fold(events), uninterrupted);
  for (let split = 0; split <= events.length; split++) {
    const checkpoint = JSON.parse(JSON.stringify(fold(events.slice(0, split))));
    const resumed = fold(events.slice(split), checkpoint);
    assert.deepEqual(resumed, uninterrupted, `checkpoint at ${split}`);
  }
  assert.equal(fold(events, uninterrupted), uninterrupted, 'already-folded ordered replay cannot double count');
  assert.equal(uninterrupted.view.timedSteps, 2);
  assertJsonSafe(uninterrupted);
});

test('fork inherited historical events remain measurable; child continuation folds at its own log offset', () => {
  const inherited = [
    start(0, 1, 1, 0),
    final(1000, { outputTokens: 100, seq: 1 }),
    end(10_000, 1, 1, 2),
    turnEnd('completed', 11_000, 1, 3),
  ];
  const boundary = event('session/end-seed', 12_000, { inheritedEventCount: 4 }, 4);
  const child = [
    boundary,
    event('turn/start', 13_000, { turn: 2 }, 5),
    start(14_000, 2, 1, 6),
    final(17_000, { turn: 2, step: 1, outputTokens: 900, seq: 7 }),
    end(50_000, 2, 1, 8),
  ];
  const historicalState = fold(inherited);
  assert.equal(applyEvent(historicalState, boundary), historicalState);
  const fullReplay = fold([...inherited, ...child]);
  const restoredParent = JSON.parse(JSON.stringify(historicalState));
  assert.deepEqual(fold(child, restoredParent), fullReplay);
  assert.equal(fullReplay.view.timedSteps, 2);
  assert.equal(fullReplay.view.totalOutputTokens, 1000);
  assert.equal(fullReplay.view.totalDurationMs, 4000);
  assert.equal(fullReplay.view.aggregateRate, 250);
});

test('invalid seq and source metadata never leak non-JSON values into derived state', () => {
  const state = fold([
    start(0, 1, 1, Infinity),
    final(1000, { seq: NaN, source: { provider: { bad: true }, model: Infinity } }),
  ]);
  assert.equal(state.watermark, null);
  assert.equal(state.view.latest.provider, null);
  assert.equal(state.view.latest.model, null);
  assert.equal(state.view.latest.status, 'measured');
  assertJsonSafe(state);
});
