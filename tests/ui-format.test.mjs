import test from 'node:test';
import assert from 'node:assert/strict';
import React from '../../../deepseek-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js';
import { throughputText, replaceThroughputValue } from '../ui-format.js';
import { readRequestRate } from '../ui-metrics.js';

const t = (key, params) => JSON.stringify({ key, ...(params ? { params } : {}) });
const metrics = { timingRecorded: true, usageProvided: true, stepStartTime: 1000, firstTokenTime: 41000, completedTime: 43000, outputTokens: 2000 };
const labels = ['original started', 'original duration', 'original TTFT', 'original generation', 'original throughput'];
function originalPanel() {
  const rows = labels.map((label, index) => React.createElement('div', { key: `row-${index}`, className: 'original-row' },
    React.createElement('dt', { key: 'label' }, label),
    React.createElement('dd', { key: 'value', className: 'original-value' }, `original value ${index}`)));
  return React.createElement('dl', { className: 'original-panel', id: 'original-id', 'aria-label': 'original aria' }, rows);
}

test('corrected rate retains the original unit locale key and one-decimal precision', () => {
  assert.equal(throughputText(readRequestRate(metrics), t), t('unit.tokensPerSecond', { value: '47.6' }));
});

test('real React element cloning changes only the original last value, not text labels or time formats', () => {
  const panel = originalPanel();
  const next = replaceThroughputValue(panel, '47.6 tok/s', React);
  assert.equal(next.type, panel.type);
  for (const key of ['className', 'id', 'aria-label']) assert.equal(next.props[key], panel.props[key]);
  for (let i = 0; i < 4; i++) assert.equal(next.props.children[i], panel.props.children[i]);
  const previous = panel.props.children[4];
  const changed = next.props.children[4];
  assert.equal(changed.props.className, previous.props.className);
  assert.equal(changed.props.children[0], previous.props.children[0]);
  assert.equal(changed.props.children[1].props.className, previous.props.children[1].props.className);
  assert.equal(changed.props.children[1].props.children, '47.6 tok/s');
  assert.equal(previous.props.children[1].props.children, 'original value 4');
  assert.deepEqual(next.props.children.map((row) => row.props.children[0].props.children), labels);
});

test('no descriptions or output rows are appended to the original five-row panel', () => {
  const next = replaceThroughputValue(originalPanel(), '47.6 tok/s', React);
  assert.equal(next.props.children.length, 5);
  assert.deepEqual(next.props.children.map((row) => row.key), ['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
});

test('original timestamp control nodes retain identity and their own state/rendering', () => {
  const panel = originalPanel();
  const control = React.createElement('button', { title: 'original title', onClick() {} }, '2026-11-05 08:02:03.004');
  const start = React.cloneElement(panel.props.children[0], { children: [panel.props.children[0].props.children[0], control] });
  const withClock = React.cloneElement(panel, { children: [start, ...panel.props.children.slice(1)] });
  const next = replaceThroughputValue(withClock, '47.6 tok/s', React);
  assert.equal(next.props.children[0], start);
  assert.equal(next.props.children[0].props.children[1], control);
});

test('unrecognized layouts are refused instead of rewriting arbitrary text', () => {
  assert.throws(() => replaceThroughputValue(React.createElement('div', null, 'unrelated'), '47.6', React));
  assert.throws(() => replaceThroughputValue(React.createElement('dl', null, []), '47.6', React));
  const panel = originalPanel();
  const wrong = React.cloneElement(panel.props.children[4], { children: [React.createElement('span', null, 'label'), React.createElement('dd', null, 'value')] });
  assert.throws(() => replaceThroughputValue(React.cloneElement(panel, { children: [...panel.props.children.slice(0, 4), wrong] }), '47.6', React));
});

test('unmeasurable rates reuse original messages without introducing new UI copy', () => {
  const expected = {
    pending: 'status.pending', 'missing-start': 'timing.stepStartUnavailable',
    'not-recorded': 'timing.notRecorded', 'missing-usage': 'timing.usageUnavailable',
    'contradictory-usage': 'timing.usageUnavailable', 'invalid-usage': 'timing.outputTokensUnavailable',
    'too-short': 'timing.durationTooShort', 'zero-duration': 'timing.durationTooShort',
    'clock-regression': 'timing.durationTooShort', interrupted: 'timing.notAvailable',
  };
  for (const [reason, key] of Object.entries(expected)) assert.equal(throughputText({ rate: null, reason }, t), t(key));
});
