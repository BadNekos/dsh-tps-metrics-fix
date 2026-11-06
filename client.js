(() => {
  // metrics.js
  var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
  var USAGE_FIELDS = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens"
  ];
  var isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  var isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  var isTime = (value) => Number.isSafeInteger(value);
  function safeAdd(left, right) {
    if (!isCount(left) || !isCount(right) || right > MAX_SAFE_INTEGER - left) {
      return null;
    }
    return left + right;
  }
  function requestRate(outputTokens, startTime, completedTime, minDurationMs = 100) {
    if (startTime === null || startTime === void 0) {
      return { rate: null, durationMs: null, reason: "missing-start" };
    }
    if (!isTime(startTime) || !isTime(completedTime)) {
      return { rate: null, durationMs: null, reason: "invalid-time" };
    }
    const durationMs = completedTime - startTime;
    if (durationMs < 0) {
      return { rate: null, durationMs: null, reason: "clock-regression" };
    }
    if (!isCount(durationMs)) {
      return { rate: null, durationMs: null, reason: "duration-overflow" };
    }
    if (durationMs === 0) {
      return { rate: null, durationMs: 0, reason: "zero-duration" };
    }
    if (!isCount(outputTokens)) {
      return { rate: null, durationMs, reason: "invalid-usage" };
    }
    if (!isCount(minDurationMs)) {
      return { rate: null, durationMs, reason: "invalid-min-duration" };
    }
    if (durationMs < minDurationMs) {
      return { rate: null, durationMs, reason: "too-short" };
    }
    const rate = outputTokens / (durationMs / 1e3);
    return Number.isFinite(rate) ? { rate, durationMs, reason: null } : { rate: null, durationMs, reason: "non-finite-rate" };
  }
  function readUsage(usage) {
    if (!isRecord(usage)) {
      return { outputTokens: null, reasoningTokens: null, reason: "missing-usage" };
    }
    const outputTokens = isCount(usage.outputTokens) ? usage.outputTokens : null;
    const reasoningTokens = isCount(usage.reasoningTokens) ? usage.reasoningTokens : null;
    const valid = isCount(usage.inputTokens) && outputTokens !== null && USAGE_FIELDS.every((field) => usage[field] === void 0 || isCount(usage[field]));
    let reason = valid ? null : "invalid-usage";
    if (valid && reasoningTokens !== null && reasoningTokens > outputTokens) reason = "contradictory-usage";
    if (valid && usage.totalTokens !== void 0) {
      const knownMinimum = [usage.inputTokens, outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].reduce((total, count) => total === null ? null : safeAdd(total, count), 0);
      if (knownMinimum === null || usage.totalTokens < knownMinimum) reason = "contradictory-usage";
    }
    return { outputTokens, reasoningTokens, reason };
  }

  // ui-metrics.js
  function adaptSessionStats(stats, view) {
    const valid = view && Number.isSafeInteger(view.totalOutputTokens) && view.totalOutputTokens >= 0 && Number.isSafeInteger(view.totalDurationMs) && view.totalDurationMs > 0 && Number.isSafeInteger(view.timedSteps) && view.timedSteps > 0;
    return {
      ...stats && typeof stats === "object" ? stats : {},
      decodeTokens: valid ? view.totalOutputTokens : 0,
      decodeMs: valid ? view.totalDurationMs : 0
    };
  }
  function readRequestRate(metrics, options = {}) {
    const { minDurationMs = 100, interrupted = false, hasOutput = false } = options;
    const unavailable = (reason) => ({ rate: null, durationMs: null, reason });
    if (interrupted) return unavailable("interrupted");
    if (!metrics || metrics.usageProvided !== true) return unavailable("missing-usage");
    if (metrics.completedTime === null || metrics.completedTime === void 0) return unavailable("pending");
    if (metrics.stepStartTime === null || metrics.stepStartTime === void 0) return unavailable("missing-start");
    if (metrics.timingRecorded !== true) return unavailable("not-recorded");
    if (options.usage !== void 0) {
      const usage = readUsage(options.usage);
      if (usage.reason !== null) return unavailable(usage.reason);
      if (usage.outputTokens !== metrics.outputTokens) return unavailable("contradictory-usage");
    }
    if (metrics.outputTokens === 0 && hasOutput) return unavailable("contradictory-usage");
    return requestRate(metrics.outputTokens, metrics.stepStartTime, metrics.completedTime, minDurationMs);
  }
  function timingElementKind(props) {
    if (!props || typeof props !== "object") return null;
    const metrics = props.metrics;
    if (metrics && typeof metrics === "object" && "timingRecorded" in metrics && "usageProvided" in metrics && "outputTokens" in metrics && "stepStartTime" in metrics && "completedTime" in metrics) return "panel";
    if (Array.isArray(props.turns) && Array.isArray(props.requestNumbers)) return "table";
    if (props.record?.cell?.assistantMetrics !== void 0 || props.assistant?.cell?.assistantMetrics !== void 0) return "record";
    if (Object.hasOwn(props, "assistant") && Object.hasOwn(props, "anchor") && Object.hasOwn(props, "request")) return "request";
    return null;
  }
  function recordFacts(props) {
    const record = props?.record ?? props?.assistant;
    if (!record?.cell) return null;
    const cell = record.cell;
    const projectedUsage = ["input", "output", "think", "cacheRead", "cacheWrite"].some((field) => Object.hasOwn(cell, field)) ? {
      inputTokens: cell.input,
      outputTokens: cell.output,
      ...cell.think === void 0 ? {} : { reasoningTokens: cell.think },
      ...cell.cacheRead === void 0 ? {} : { cacheReadTokens: cell.cacheRead },
      ...cell.cacheWrite === void 0 ? {} : { cacheWriteTokens: cell.cacheWrite }
    } : void 0;
    return {
      metrics: cell.assistantMetrics ?? null,
      interrupted: cell.isError === true || cell.interrupted === true,
      usage: Object.hasOwn(cell, "usage") ? cell.usage : projectedUsage,
      hasOutput: typeof cell.outputDetail === "string" && cell.outputDetail.length > 0 || typeof cell.thinkingDetail === "string" && cell.thinkingDetail.length > 0 || cell.sourceBlocks?.some((block) => block.type === "tool-call" || (block.type === "text" || block.type === "reasoning") && (typeof block.content === "string" && block.content.length > 0 || typeof block.text === "string" && block.text.length > 0)) === true
    };
  }

  // ui-format.js
  function throughputText(reading, t) {
    if (reading.rate !== null) return t("unit.tokensPerSecond", { value: reading.rate.toFixed(1) });
    switch (reading.reason) {
      case "pending":
        return t("status.pending");
      case "missing-start":
        return t("timing.stepStartUnavailable");
      case "not-recorded":
        return t("timing.notRecorded");
      case "missing-usage":
      case "contradictory-usage":
        return t("timing.usageUnavailable");
      case "invalid-usage":
        return t("timing.outputTokensUnavailable");
      case "too-short":
      case "zero-duration":
      case "clock-regression":
        return t("timing.durationTooShort");
      default:
        return t("timing.notAvailable");
    }
  }
  function replaceThroughputValue(panel, value, React) {
    const rows = panel?.props?.children;
    if (!React.isValidElement(panel) || panel.type !== "dl" || !Array.isArray(rows) || rows.length !== 5) {
      throw new Error("Unsupported original trajectory timing panel");
    }
    const row = rows[4];
    const cells = row?.props?.children;
    if (!React.isValidElement(row) || row.type !== "div" || !Array.isArray(cells) || cells.length !== 2 || !React.isValidElement(cells[0]) || cells[0].type !== "dt" || !React.isValidElement(cells[1]) || cells[1].type !== "dd") {
      throw new Error("Unsupported original throughput value");
    }
    const nextValue = React.cloneElement(cells[1], { key: cells[1].key ?? "throughput-value", children: value });
    const nextRow = React.cloneElement(row, { key: row.key ?? "throughput", children: [cells[0], nextValue] });
    return React.cloneElement(panel, { children: [...rows.slice(0, 4), nextRow] });
  }

  // src/client.js
  window.__ModuleLoader__.load({
    id: "@local/dsh-tps-metrics-fix",
    factory(require2) {
      const React = require2("react");
      const h = React.createElement;
      const KEY = "dshTpsMetrics";
      function plainComponent(component) {
        if (typeof component === "function" && !component.prototype?.isReactComponent) return component;
        if (component && component.$$typeof === /* @__PURE__ */ Symbol.for("react.memo")) return plainComponent(component.type);
        return null;
      }
      function keepMemo(original, replacement) {
        return original?.$$typeof === /* @__PURE__ */ Symbol.for("react.memo") ? React.memo(replacement, original.compare) : replacement;
      }
      function FixedTimingPanel({ originalComponent, metrics, t, tpsContext }) {
        const { minDurationMs, facts } = tpsContext;
        const matchingFacts = facts?.metrics === metrics ? facts : null;
        const reading = readRequestRate(metrics, {
          minDurationMs,
          interrupted: matchingFacts?.interrupted === true,
          hasOutput: matchingFacts?.hasOutput === true,
          usage: matchingFacts?.usage
        });
        const panel = originalComponent({ metrics, t });
        return replaceThroughputValue(panel, throughputText(reading, t), React);
      }
      return {
        inject: ["slots"],
        apply(ctx, config = {}) {
          if (config.enabled === false) return;
          const minDurationMs = config.minDurationMs ?? 100;
          if (!Number.isSafeInteger(minDurationMs) || minDurationMs < 1 || minDurationMs > 6e4) {
            throw new Error("tps-metrics-fix: minDurationMs must be an integer from 1 to 60000");
          }
          const slots = ctx.slots;
          const ownedComponents = /* @__PURE__ */ new WeakSet();
          const componentCache = /* @__PURE__ */ new WeakMap();
          const traversalCache = /* @__PURE__ */ new WeakMap();
          const healthStates = /* @__PURE__ */ new Map();
          const health = (key, value) => {
            if (healthStates.get(key) === value) return;
            healthStates.set(key, value);
            if (value === "unsupported") console.warn(`[tps-metrics-fix] Unsupported ${key} adapter`);
          };
          let refreshSequence = 0;
          let ended = false;
          const warn = (location, error) => console.warn(`[tps-metrics-fix] ${location}`, error);
          ctx.effect(() => () => {
            ended = true;
          }, "tps-metrics-fix: owner");
          function traverse(node, context, depth = 0) {
            if (Array.isArray(node)) {
              const next = node.map((child) => traverse(child, context, depth));
              return next.every((child, index) => child === node[index]) ? node : next;
            }
            if (!React.isValidElement(node)) return node;
            const facts = recordFacts(node.props) ?? context.facts;
            const local = facts === context.facts ? context : { ...context, facts };
            const kind = timingElementKind(node.props);
            const fn = plainComponent(node.type);
            if (kind === "panel") {
              if (!fn || typeof node.props.t !== "function") throw new Error("Unsupported original timing renderer");
              return h(FixedTimingPanel, { ...node.key === null ? {} : { key: node.key }, originalComponent: fn, metrics: node.props.metrics, t: node.props.t, tpsContext: local });
            }
            if (fn && kind !== null && depth < 6) {
              let Wrapped = traversalCache.get(node.type);
              if (!Wrapped) {
                let TimingTraversal = function({ __dshTpsContext, __dshTpsDepth, ...props }) {
                  const output = Original(props);
                  return traverse(output, __dshTpsContext, __dshTpsDepth);
                };
                const Original = fn;
                Wrapped = keepMemo(node.type, TimingTraversal);
                traversalCache.set(node.type, Wrapped);
              }
              return h(Wrapped, { ...node.props, ...node.key === null ? {} : { key: node.key }, __dshTpsContext: local, __dshTpsDepth: depth + 1 });
            }
            if (!Object.hasOwn(node.props, "children")) return node;
            const children = traverse(node.props.children, local, depth);
            return children === node.props.children ? node : React.cloneElement(node, { children });
          }
          function controlWrapper(entry, mode) {
            let byMode = componentCache.get(entry.component);
            if (!byMode) {
              byMode = /* @__PURE__ */ new Map();
              componentCache.set(entry.component, byMode);
            }
            if (byMode.has(mode)) return byMode.get(mode);
            const Original = entry.component;
            function EndToEndControl(props) {
              const view = props.useProjection(KEY);
              const projection = React.useCallback((key, ...args) => {
                const value = props.useProjection(key, ...args);
                return key === "sessionStats" && args.length === 0 ? adaptSessionStats(value, view) : value;
              }, [props.useProjection, view]);
              return h(Original, { ...props, useProjection: projection });
            }
            const Wrapped = keepMemo(entry.component, EndToEndControl);
            ownedComponents.add(Wrapped);
            byMode.set(mode, Wrapped);
            return Wrapped;
          }
          function installControl(key, id, mode, accept) {
            return slots.inject(key, () => {
              let current = null;
              let replacement = null;
              let blocked = null;
              let changing = false;
              let disposed = false;
              function release() {
                const stop = replacement;
                replacement = null;
                if (stop) stop();
              }
              function update() {
                if (ended || disposed || changing) return;
                const entry = slots.entries(key).find((candidate) => candidate.options.id === id && !ownedComponents.has(candidate.component) && accept(candidate));
                if (entry === current && replacement) return;
                if (entry === blocked) return;
                changing = true;
                try {
                  release();
                  current = entry ?? null;
                  if (!entry) {
                    health(mode === "owo" ? "owo" : "composer", mode === "owo" ? "absent" : "waiting");
                    return;
                  }
                  if (!plainComponent(entry.component) || entry.children && Object.keys(entry.children).length > 0) {
                    blocked = entry;
                    health(mode === "owo" ? "owo" : "composer", "unsupported");
                    return;
                  }
                  const Component = controlWrapper(entry, mode);
                  replacement = slots.register({
                    name: key,
                    ...entry.options,
                    priority: (entry.options.priority ?? 0) - 1,
                    ...entry.locale ? { locale: entry.locale } : {},
                    ...entry.store ? { store: entry.store } : {},
                    ...entry.inject ? { inject: entry.inject } : {}
                  }, Component);
                  blocked = null;
                  health(mode === "owo" ? "owo" : "composer", "patched");
                } catch (error) {
                  release();
                  blocked = entry ?? null;
                  health(mode === "owo" ? "owo" : "composer", "error");
                  warn(mode, error);
                } finally {
                  changing = false;
                }
              }
              const unsubscribe = slots.subscribe(key, update);
              const removeError = slots.onEntryError((slot, entry, error) => {
                if (slot !== key || !ownedComponents.has(entry.component)) return;
                blocked = current;
                release();
                health(mode === "owo" ? "owo" : "composer", "error");
                warn(mode, error);
              });
              update();
              return () => {
                disposed = true;
                unsubscribe();
                removeError();
                release();
              };
            });
          }
          function installTrajectory() {
            const key = "conversation.view";
            return slots.inject(key, () => {
              let held = null;
              let original = null;
              let wrapped = null;
              let blocked = null;
              let changing = false;
              let disposed = false;
              function notify() {
                if (ended || disposed || !slots.spec(key)) return;
                const stop = slots.register({ name: key, id: `tps-metrics-fix-refresh-${++refreshSequence}`, order: 1e4 }, () => null);
                stop();
              }
              function release() {
                if (held && held.component === wrapped) {
                  held.component = original;
                  notify();
                }
                held = null;
                original = null;
                wrapped = null;
              }
              function update() {
                if (ended || disposed || changing) return;
                const entry = slots.entries(key).find((candidate) => candidate.options.id === "trajectory");
                if (entry === held && entry?.component === wrapped) return;
                if (entry === held && entry?.component !== wrapped) {
                  blocked = entry;
                  held = null;
                  original = null;
                  wrapped = null;
                  health("trajectory", "unsupported");
                  return;
                }
                if (entry === blocked) return;
                changing = true;
                try {
                  let EndToEndTrajectory = function(props) {
                    return traverse(Original(props), { minDurationMs, facts: null });
                  };
                  release();
                  if (!entry) {
                    health("trajectory", "waiting");
                    return;
                  }
                  const Original = plainComponent(entry.component);
                  const source = Original ? Function.prototype.toString.call(Original) : "";
                  if (!Original || !source.includes("useTrajectory") || !source.includes("requestNumbers")) {
                    blocked = entry;
                    health("trajectory", "unsupported");
                    return;
                  }
                  original = entry.component;
                  wrapped = keepMemo(original, EndToEndTrajectory);
                  ownedComponents.add(wrapped);
                  held = entry;
                  entry.component = wrapped;
                  blocked = null;
                  health("trajectory", "patched");
                  notify();
                } catch (error) {
                  release();
                  blocked = entry ?? null;
                  health("trajectory", "error");
                  warn("trajectory", error);
                } finally {
                  changing = false;
                }
              }
              const unsubscribe = slots.subscribe(key, update);
              const removeError = slots.onEntryError((slot, entry, error) => {
                if (slot !== key || entry !== held) return;
                blocked = held;
                release();
                health("trajectory", "error");
                warn("trajectory", error);
              });
              update();
              return () => {
                disposed = true;
                unsubscribe();
                removeError();
                release();
              };
            });
          }
          const capable = ["entries", "subscribe", "register", "inject", "onEntryError", "spec"].every((method) => typeof slots[method] === "function");
          if (!capable) {
            health("composer", "unsupported");
            health("trajectory", "unsupported");
            return;
          }
          installControl("conversation.composer.dock", "activity", "native", (entry) => !!entry.locale);
          installControl("conversation.input.right", "dsh-owo.client-ui-composer-usage", "owo", () => true);
          installTrajectory();
        }
      };
    }
  });
})();
