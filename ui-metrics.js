import { readUsage, requestRate } from './metrics.js';

/** Adapt a legacy renderer's two rate inputs only; retain its counts, TTFT, and tool/model times. */
export function adaptSessionStats(stats, view) {
  const valid = view && Number.isSafeInteger(view.totalOutputTokens) && view.totalOutputTokens >= 0
    && Number.isSafeInteger(view.totalDurationMs) && view.totalDurationMs > 0
    && Number.isSafeInteger(view.timedSteps) && view.timedSteps > 0;
  return {
    ...(stats && typeof stats === 'object' ? stats : {}),
    decodeTokens: valid ? view.totalOutputTokens : 0,
    decodeMs: valid ? view.totalDurationMs : 0,
  };
}

/** Read a request's complete response interval without consulting firstTokenTime. */
export function readRequestRate(metrics, options = {}) {
  const { minDurationMs = 100, interrupted = false, hasOutput = false } = options;
  const unavailable = (reason) => ({ rate: null, durationMs: null, reason });
  if (interrupted) return unavailable('interrupted');
  if (!metrics || metrics.usageProvided !== true) return unavailable('missing-usage');
  if (metrics.completedTime === null || metrics.completedTime === undefined) return unavailable('pending');
  if (metrics.stepStartTime === null || metrics.stepStartTime === undefined) return unavailable('missing-start');
  if (metrics.timingRecorded !== true) return unavailable('not-recorded');
  if (options.usage !== undefined) {
    const usage = readUsage(options.usage);
    if (usage.reason !== null) return unavailable(usage.reason);
    if (usage.outputTokens !== metrics.outputTokens) return unavailable('contradictory-usage');
  }
  if (metrics.outputTokens === 0 && hasOutput) return unavailable('contradictory-usage');
  return requestRate(metrics.outputTokens, metrics.stepStartTime, metrics.completedTime, minDurationMs);
}

/** Only these exact existing-UI inputs require a compatibility adapter. */
export function timingElementKind(props) {
  if (!props || typeof props !== 'object') return null;
  const metrics = props.metrics;
  if (metrics && typeof metrics === 'object'
    && 'timingRecorded' in metrics && 'usageProvided' in metrics
    && 'outputTokens' in metrics && 'stepStartTime' in metrics && 'completedTime' in metrics) return 'panel';
  if (Array.isArray(props.turns) && Array.isArray(props.requestNumbers)) return 'table';
  if (props.record?.cell?.assistantMetrics !== undefined || props.assistant?.cell?.assistantMetrics !== undefined) return 'record';
  if (Object.hasOwn(props, 'assistant') && Object.hasOwn(props, 'anchor') && Object.hasOwn(props, 'request')) return 'request';
  return null;
}

/** Retain the owning record's interruption and output facts while traversing timing components. */
export function recordFacts(props) {
  const record = props?.record ?? props?.assistant;
  if (!record?.cell) return null;
  const cell = record.cell;
  // These disjoint billing fields are attached by the original trajectory layout.
  const projectedUsage = ['input', 'output', 'think', 'cacheRead', 'cacheWrite'].some((field) => Object.hasOwn(cell, field))
    ? { inputTokens: cell.input, outputTokens: cell.output,
      ...(cell.think === undefined ? {} : { reasoningTokens: cell.think }),
      ...(cell.cacheRead === undefined ? {} : { cacheReadTokens: cell.cacheRead }),
      ...(cell.cacheWrite === undefined ? {} : { cacheWriteTokens: cell.cacheWrite }) }
    : undefined;
  return {
    metrics: cell.assistantMetrics ?? null,
    interrupted: cell.isError === true || cell.interrupted === true,
    usage: Object.hasOwn(cell, 'usage') ? cell.usage : projectedUsage,
    hasOutput: (typeof cell.outputDetail === 'string' && cell.outputDetail.length > 0)
      || (typeof cell.thinkingDetail === 'string' && cell.thinkingDetail.length > 0)
      || cell.sourceBlocks?.some((block) => block.type === 'tool-call'
        || ((block.type === 'text' || block.type === 'reasoning')
          && ((typeof block.content === 'string' && block.content.length > 0)
            || (typeof block.text === 'string' && block.text.length > 0)))) === true,
  };
}
