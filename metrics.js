// Pure, JSON-persistable session metrics. The committed step/start and final
// assistant/message timestamps are the only clock inputs: packed deltas,
// firstTokenTime, retries, and subsequent tool execution never change the rate.

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const RELEVANT_EVENTS = new Set([
  'step/start',
  'assistant/message',
  'step/end',
  'turn/end',
]);
const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
];
const TIME_REASONS = new Set([
  'missing-start',
  'invalid-time',
  'clock-regression',
  'duration-overflow',
  'zero-duration',
  'invalid-min-duration',
  'too-short',
  'non-finite-rate',
]);

const isRecord = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isTime = (value) => Number.isSafeInteger(value);
const nullableString = (value) => typeof value === 'string' ? value : null;
const sameStep = (left, right) => left !== null && right !== null
  && left.turn === right.turn && left.step === right.step;

function safeAdd(left, right) {
  if (!isCount(left) || !isCount(right) || right > MAX_SAFE_INTEGER - left) {
    return null;
  }
  return left + right;
}

/**
 * API output tokens divided by the complete logical request duration in seconds.
 * Times and token counts must be safe integers. A short duration is excluded,
 * not raised to the configured minimum. Reversed clocks are never clamped.
 * Invalid inputs return a reason, never NaN/Infinity or a guessed token count.
 */
export function requestRate(outputTokens, startTime, completedTime, minDurationMs = 100) {
  if (startTime === null || startTime === undefined) {
    return { rate: null, durationMs: null, reason: 'missing-start' };
  }
  if (!isTime(startTime) || !isTime(completedTime)) {
    return { rate: null, durationMs: null, reason: 'invalid-time' };
  }

  const durationMs = completedTime - startTime;
  if (durationMs < 0) {
    return { rate: null, durationMs: null, reason: 'clock-regression' };
  }
  if (!isCount(durationMs)) {
    return { rate: null, durationMs: null, reason: 'duration-overflow' };
  }
  if (durationMs === 0) {
    return { rate: null, durationMs: 0, reason: 'zero-duration' };
  }
  if (!isCount(outputTokens)) {
    return { rate: null, durationMs, reason: 'invalid-usage' };
  }
  if (!isCount(minDurationMs)) {
    return { rate: null, durationMs, reason: 'invalid-min-duration' };
  }
  if (durationMs < minDurationMs) {
    return { rate: null, durationMs, reason: 'too-short' };
  }

  // Divide by seconds rather than multiplying a safe token count by 1000.
  const rate = outputTokens / (durationMs / 1000);
  return Number.isFinite(rate)
    ? { rate, durationMs, reason: null }
    : { rate: null, durationMs, reason: 'non-finite-rate' };
}

export function createInitialState() {
  return {
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
  };
}

/** Validate available canonical billing fields identically for the fold and request UI. */
export function readUsage(usage) {
  if (!isRecord(usage)) {
    return { outputTokens: null, reasoningTokens: null, reason: 'missing-usage' };
  }
  const outputTokens = isCount(usage.outputTokens) ? usage.outputTokens : null;
  const reasoningTokens = isCount(usage.reasoningTokens) ? usage.reasoningTokens : null;
  const valid = isCount(usage.inputTokens) && outputTokens !== null
    && USAGE_FIELDS.every((field) => usage[field] === undefined || isCount(usage[field]));
  let reason = valid ? null : 'invalid-usage';
  if (valid && reasoningTokens !== null && reasoningTokens > outputTokens) reason = 'contradictory-usage';
  if (valid && usage.totalTokens !== undefined) {
    const knownMinimum = [usage.inputTokens, outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
      .reduce((total, count) => total === null ? null : safeAdd(total, count), 0);
    if (knownMinimum === null || usage.totalTokens < knownMinimum) reason = 'contradictory-usage';
  }
  return { outputTokens, reasoningTokens, reason };
}

function hasModelOutput(content) {
  return Array.isArray(content) && content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === 'text' || block.type === 'reasoning') {
      return typeof block.text === 'string' && block.text.length > 0;
    }
    if (block.type === 'tool-call') {
      return (typeof block.name === 'string' && block.name.length > 0)
        || (typeof block.arguments === 'string' && block.arguments.length > 0);
    }
    return false;
  });
}

function boundaryLatest(step, status) {
  return {
    turn: step.turn,
    step: step.step,
    provider: null,
    model: null,
    outputTokens: null,
    reasoningTokens: null,
    durationMs: null,
    rate: null,
    status,
  };
}

function settle(state, latest) {
  let view = state.view;
  if (latest.status === 'measured') {
    const totalOutputTokens = safeAdd(view.totalOutputTokens, latest.outputTokens);
    const totalDurationMs = safeAdd(view.totalDurationMs, latest.durationMs);
    const timedSteps = safeAdd(view.timedSteps, 1);
    if (totalOutputTokens !== null && totalDurationMs !== null && timedSteps !== null) {
      const aggregateRate = totalOutputTokens / (totalDurationMs / 1000);
      if (Number.isFinite(aggregateRate)) {
        view = { ...view, totalOutputTokens, totalDurationMs, timedSteps, aggregateRate, latest };
      } else {
        latest = { ...latest, rate: null, status: 'aggregate-overflow' };
      }
    } else {
      // Reject the entire sample from both totals. Never accumulate just one
      // side of the ratio, saturate a total, or pretend an unsafe sum is exact.
      latest = { ...latest, rate: null, status: 'aggregate-overflow' };
    }
  }
  if (latest.status !== 'measured') {
    const excludedSteps = safeAdd(view.excludedSteps, 1);
    if (excludedSteps === null) {
      latest = { ...latest, rate: null, status: 'counter-overflow' };
      view = { ...view, latest };
    } else {
      view = { ...view, excludedSteps, latest };
    }
  }
  return {
    ...state,
    settledStep: { turn: latest.turn, step: latest.step },
    view,
  };
}

function turnEndStatus(kind) {
  if (kind === 'aborted' || kind === 'cancelled' || kind === 'canceled') return 'cancelled';
  if (kind === 'error' || kind === 'failed') return 'failed';
  if (kind === 'interrupted') return 'interrupted';
  return 'no-response';
}

function withWatermark(previous, next, seq) {
  if (next === previous || !isCount(seq) || next.watermark === seq) return next;
  return { ...next, watermark: seq };
}

/**
 * Fold committed events in append/restore order. Invalid/missing seq values are
 * not copied into state, so sequence-less fixtures also fold normally. Only
 * relevant events advance the replay watermark; all other events return the
 * exact input reference. Boundary-only changes retain the same view reference.
 *
 * openStep.startTime=null means a matched start carried an invalid timestamp.
 * settledStep prevents duplicate settlement even in sequence-less fixtures.
 * A final response is settled before step/end or any subsequent tool work.
 */
export function applyEvent(state, event, { minDurationMs = 100 } = {}) {
  if (!isRecord(event) || !RELEVANT_EVENTS.has(event.type) || !isRecord(event.data)) {
    return state;
  }
  if (isCount(event.seq) && isCount(state.watermark) && event.seq <= state.watermark) {
    return state;
  }
  const data = event.data;
  if (!isCount(data.turn) || (event.type !== 'turn/end' && !isCount(data.step))) {
    return state;
  }

  let next = state;
  if (event.type === 'step/start') {
    if (sameStep(state.openStep, data) || sameStep(state.settledStep, data)) return state;
    if (state.openStep !== null && !state.openStep.settled) {
      next = settle(state, boundaryLatest(state.openStep, 'no-response'));
    }
    next = {
      ...next,
      openStep: {
        turn: data.turn,
        step: data.step,
        startTime: isTime(event.time) ? event.time : null,
        settled: false,
      },
    };
  } else if (event.type === 'assistant/message') {
    if (sameStep(state.settledStep, data)
      || (sameStep(state.openStep, data) && state.openStep.settled)) return state;
    const matched = sameStep(state.openStep, data);
    const usage = readUsage(data.usage);
    const timing = requestRate(
      usage.outputTokens,
      matched ? state.openStep.startTime : null,
      event.time,
      minDurationMs,
    );
    const message = isRecord(data.message) ? data.message : null;
    const source = message !== null && isRecord(message.source) ? message.source : null;
    let status = timing.reason ?? 'measured';
    if (data.interrupted === true) {
      status = 'interrupted';
    } else if (!matched) {
      status = 'missing-start';
    } else if (state.openStep.startTime === null) {
      status = 'invalid-time';
    } else if (message === null || message.role !== 'assistant' || !Array.isArray(message.content)) {
      status = 'invalid-message';
    } else if (!TIME_REASONS.has(timing.reason)) {
      if (usage.reason !== null) {
        status = usage.reason;
      } else if (usage.outputTokens === 0
        && (hasModelOutput(message.content) || (usage.reasoningTokens ?? 0) > 0)) {
        status = 'contradictory-usage';
      }
    }
    next = settle(state, {
      turn: data.turn,
      step: data.step,
      provider: nullableString(source?.provider),
      model: nullableString(source?.model),
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      durationMs: timing.durationMs,
      rate: status === 'measured' ? timing.rate : null,
      status,
    });
    if (matched) next = { ...next, openStep: { ...state.openStep, settled: true } };
  } else if (event.type === 'step/end') {
    if (!sameStep(state.openStep, data)) return state;
    if (!state.openStep.settled) {
      next = settle(state, boundaryLatest(state.openStep, 'no-response'));
    }
    next = { ...next, openStep: null };
  } else if (event.type === 'turn/end') {
    const status = turnEndStatus(data.reason?.kind);
    if (state.openStep !== null && state.openStep.turn === data.turn) {
      if (!state.openStep.settled) {
        next = settle(state, boundaryLatest(state.openStep, status));
      }
      next = { ...next, openStep: null };
    }
    const latest = next.view.latest;
    // step/end has no outcome reason. Refine its exclusion (or an interrupted
    // message) when the durable turn outcome arrives, without recounting it.
    // Never revoke a completed response merely because later tool work failed.
    if (latest !== null && latest.turn === data.turn && status !== 'no-response'
      && (latest.status === 'no-response' || latest.status === 'interrupted')
      && latest.status !== status) {
      next = { ...next, view: { ...next.view, latest: { ...latest, status } } };
    }
  }
  return withWatermark(state, next, event.seq);
}
