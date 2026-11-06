import { adaptSessionStats, readRequestRate, recordFacts, timingElementKind } from '../ui-metrics.js';
import { replaceThroughputValue, throughputText } from '../ui-format.js';

window.__ModuleLoader__.load({
  id: '@local/dsh-tps-metrics-fix',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const KEY = 'dshTpsMetrics';

    function plainComponent(component) {
      if (typeof component === 'function' && !component.prototype?.isReactComponent) return component;
      if (component && component.$$typeof === Symbol.for('react.memo')) return plainComponent(component.type);
      return null;
    }
    function keepMemo(original, replacement) {
      return original?.$$typeof === Symbol.for('react.memo') ? React.memo(replacement, original.compare) : replacement;
    }
    function FixedTimingPanel({ originalComponent, metrics, t, tpsContext }) {
      const { minDurationMs, facts } = tpsContext;
      const matchingFacts = facts?.metrics === metrics ? facts : null;
      const reading = readRequestRate(metrics, {
        minDurationMs,
        interrupted: matchingFacts?.interrupted === true,
        hasOutput: matchingFacts?.hasOutput === true,
        usage: matchingFacts?.usage,
      });
      const panel = originalComponent({ metrics, t });
      return replaceThroughputValue(panel, throughputText(reading, t), React);
    }

    return {
      inject: ['slots'],
      apply(ctx, config = {}) {
        if (config.enabled === false) return;
        const minDurationMs = config.minDurationMs ?? 100;
        if (!Number.isSafeInteger(minDurationMs) || minDurationMs < 1 || minDurationMs > 60000) {
          throw new Error('tps-metrics-fix: minDurationMs must be an integer from 1 to 60000');
        }
        const slots = ctx.slots;
        const ownedComponents = new WeakSet();
        const componentCache = new WeakMap();
        const traversalCache = new WeakMap();
        const healthStates = new Map();
        const health = (key, value) => {
          if (healthStates.get(key) === value) return;
          healthStates.set(key, value);
          if (value === 'unsupported') console.warn(`[tps-metrics-fix] Unsupported ${key} adapter`);
        };
        let refreshSequence = 0;
        let ended = false;
        const warn = (location, error) => console.warn(`[tps-metrics-fix] ${location}`, error);
        ctx.effect(() => () => { ended = true; }, 'tps-metrics-fix: owner');

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
          if (kind === 'panel') {
            if (!fn || typeof node.props.t !== 'function') throw new Error('Unsupported original timing renderer');
            return h(FixedTimingPanel, { ...(node.key === null ? {} : { key: node.key }), originalComponent: fn, metrics: node.props.metrics, t: node.props.t, tpsContext: local });
          }
          if (fn && kind !== null && depth < 6) {
            let Wrapped = traversalCache.get(node.type);
            if (!Wrapped) {
              const Original = fn;
              function TimingTraversal({ __dshTpsContext, __dshTpsDepth, ...props }) {
                const output = Original(props);
                return traverse(output, __dshTpsContext, __dshTpsDepth);
              }
              Wrapped = keepMemo(node.type, TimingTraversal);
              traversalCache.set(node.type, Wrapped);
            }
            return h(Wrapped, { ...node.props, ...(node.key === null ? {} : { key: node.key }), __dshTpsContext: local, __dshTpsDepth: depth + 1 });
          }
          if (!Object.hasOwn(node.props, 'children')) return node;
          const children = traverse(node.props.children, local, depth);
          return children === node.props.children ? node : React.cloneElement(node, { children });
        }

        function controlWrapper(entry, mode) {
          let byMode = componentCache.get(entry.component);
          if (!byMode) { byMode = new Map(); componentCache.set(entry.component, byMode); }
          if (byMode.has(mode)) return byMode.get(mode);
          const Original = entry.component;
          function EndToEndControl(props) {
            const view = props.useProjection(KEY);
            const projection = React.useCallback((key, ...args) => {
              const value = props.useProjection(key, ...args);
              return key === 'sessionStats' && args.length === 0 ? adaptSessionStats(value, view) : value;
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
            function release() { const stop = replacement; replacement = null; if (stop) stop(); }
            function update() {
              if (ended || disposed || changing) return;
              const entry = slots.entries(key).find((candidate) => candidate.options.id === id
                && !ownedComponents.has(candidate.component) && accept(candidate));
              if (entry === current && replacement) return;
              if (entry === blocked) return;
              changing = true;
              try {
                release(); current = entry ?? null;
                if (!entry) { health(mode === 'owo' ? 'owo' : 'composer', mode === 'owo' ? 'absent' : 'waiting'); return; }
                if (!plainComponent(entry.component) || (entry.children && Object.keys(entry.children).length > 0)) {
                  blocked = entry; health(mode === 'owo' ? 'owo' : 'composer', 'unsupported'); return;
                }
                const Component = controlWrapper(entry, mode);
                replacement = slots.register({
                  name: key, ...entry.options, priority: (entry.options.priority ?? 0) - 1,
                  ...(entry.locale ? { locale: entry.locale } : {}),
                  ...(entry.store ? { store: entry.store } : {}),
                  ...(entry.inject ? { inject: entry.inject } : {}),
                }, Component);
                blocked = null;
                health(mode === 'owo' ? 'owo' : 'composer', 'patched');
              } catch (error) {
                release(); blocked = entry ?? null; health(mode === 'owo' ? 'owo' : 'composer', 'error'); warn(mode, error);
              } finally { changing = false; }
            }
            const unsubscribe = slots.subscribe(key, update);
            const removeError = slots.onEntryError((slot, entry, error) => {
              if (slot !== key || !ownedComponents.has(entry.component)) return;
              blocked = current; release(); health(mode === 'owo' ? 'owo' : 'composer', 'error'); warn(mode, error);
            });
            update();
            return () => { disposed = true; unsubscribe(); removeError(); release(); };
          });
        }

        // Trajectory owns child Slots, so a second registration cannot safely redeclare them.
        // Only this entry's Component reference is wrapped; original services, store, inject,
        // child authorization and data stay unchanged. Compare-and-restore yields to later writers.
        function installTrajectory() {
          const key = 'conversation.view';
          return slots.inject(key, () => {
            let held = null;
            let original = null;
            let wrapped = null;
            let blocked = null;
            let changing = false;
            let disposed = false;
            function notify() {
              if (ended || disposed || !slots.spec(key)) return;
              const stop = slots.register({ name: key, id: `tps-metrics-fix-refresh-${++refreshSequence}`, order: 10000 }, () => null);
              stop();
            }
            function release() {
              if (held && held.component === wrapped) { held.component = original; notify(); }
              held = null; original = null; wrapped = null;
            }
            function update() {
              if (ended || disposed || changing) return;
              const entry = slots.entries(key).find((candidate) => candidate.options.id === 'trajectory');
              if (entry === held && entry?.component === wrapped) return;
              if (entry === held && entry?.component !== wrapped) {
                // A later writer owns this exact entry; never overwrite its change.
                blocked = entry; held = null; original = null; wrapped = null;
                health('trajectory', 'unsupported'); return;
              }
              if (entry === blocked) return;
              changing = true;
              try {
                release();
                if (!entry) { health('trajectory', 'waiting'); return; }
                const Original = plainComponent(entry.component);
                // Do not run an unverified replacement layout or a class/forwardRef renderer.
                const source = Original ? Function.prototype.toString.call(Original) : '';
                if (!Original || !source.includes('useTrajectory') || !source.includes('requestNumbers')) {
                  blocked = entry; health('trajectory', 'unsupported'); return;
                }
                original = entry.component;
                function EndToEndTrajectory(props) {
                  return traverse(Original(props), { minDurationMs, facts: null });
                }
                wrapped = keepMemo(original, EndToEndTrajectory);
                ownedComponents.add(wrapped);
                held = entry;
                entry.component = wrapped;
                blocked = null;
                health('trajectory', 'patched');
                notify();
              } catch (error) {
                release(); blocked = entry ?? null; health('trajectory', 'error'); warn('trajectory', error);
              } finally { changing = false; }
            }
            const unsubscribe = slots.subscribe(key, update);
            const removeError = slots.onEntryError((slot, entry, error) => {
              if (slot !== key || entry !== held) return;
              blocked = held; release(); health('trajectory', 'error'); warn('trajectory', error);
            });
            update();
            return () => { disposed = true; unsubscribe(); removeError(); release(); };
          });
        }

        const capable = ['entries', 'subscribe', 'register', 'inject', 'onEntryError', 'spec']
          .every((method) => typeof slots[method] === 'function');
        if (!capable) {
          health('composer', 'unsupported'); health('trajectory', 'unsupported'); return;
        }
        installControl('conversation.composer.dock', 'activity', 'native', (entry) => !!entry.locale);
        installControl('conversation.input.right', 'dsh-owo.client-ui-composer-usage', 'owo', () => true);
        installTrajectory();
      },
    };
  },
});
