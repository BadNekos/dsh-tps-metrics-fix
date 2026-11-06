import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { applyEvent, createInitialState } from './metrics.js';

/** Independent, replayable end-to-end output-rate projection. */
export const name = 'tps-metrics-fix';
export const inject = ['sessionProjections'];
export const PROJECTION_KEY = 'dshTpsMetrics';

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Enable request and session end-to-end TPS correction.'),
  minDurationMs: Schema.natural().min(1).max(60000).default(100)
    .description('Do not report a rate for samples shorter than this duration; no time or TPS is clamped.'),
});

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rate = z.number().finite().nonnegative().nullable();
const latest = z.object({
  turn: count,
  step: count,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  outputTokens: count.nullable(),
  reasoningTokens: count.nullable(),
  durationMs: count.nullable(),
  rate,
  status: z.string().min(1),
}).strict().nullable();
const viewSchema = z.object({
  totalOutputTokens: count,
  totalDurationMs: count,
  timedSteps: count,
  excludedSteps: count,
  aggregateRate: rate,
  latest,
}).strict();
const step = z.object({ turn: count, step: count }).strict();
const stateSchema = z.object({
  openStep: step.extend({ startTime: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), settled: z.boolean() }).strict().nullable(),
  watermark: count.nullable(),
  settledStep: step.nullable(),
  view: viewSchema,
}).strict();

/** Register only derived data; never rewrite events, adapters, usage, or timestamps. */
export function apply(ctx, config) {
  if (!config.enabled) return;
  const { minDurationMs } = config;
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    // A changed threshold must invalidate persisted checkpoints as well as module revisions.
    stateVersion: 1000000 + minDurationMs,
    stateSchema,
    init: () => createInitialState(),
    apply: (state, event) => applyEvent(state, event, { minDurationMs }),
    wire: { viewSchema, view: (state) => state.view },
  });
}
