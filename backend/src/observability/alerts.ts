/**
 * W6-3 — the generic operational-alert seam (docs/37 §15/§26).
 *
 * `emitOperationalAlert`-shaped: structured, keyed, deduplicated with a
 * re-alert suppression window, and delivered by a pluggable destination.
 * W6 ships the STRUCTURED-LOG destination only — Slack/PagerDuty/email
 * selection follows the infrastructure/staffing decision (docs/36 OP-07/
 * OP-08/IN-10) and is deliberately not chosen here.
 *
 * Facts are bounded MACHINE facts (ids, counts, codes) — never payloads,
 * messages, or secrets. Keys and codes are shape-checked so nothing
 * free-form reaches a log line through this seam.
 */
import type pino from 'pino';

export type AlertSeverity = 'warning' | 'critical';

export interface OperationalAlert {
  /** Stable dedup key (e.g. `stuck:gatewayEvent:<id>`). */
  key: string;
  severity: AlertSeverity;
  /** Bounded machine code (e.g. `stuckPaymentState`). */
  code: string;
  facts?: Record<string, unknown>;
}

export interface AlertEmitter {
  /** Emits unless the key is active and re-alert suppression still holds. */
  raise(alert: OperationalAlert): 'raised' | 'suppressed';
  /**
   * Emits an all-clear for a key. `known` lets a caller with DURABLE
   * knowledge (e.g. the previous run's facts) clear a key this process
   * never raised itself — multi-replica safe by construction.
   */
  clear(key: string, options?: { known?: boolean }): 'cleared' | 'inactive';
  activeKeys(): string[];
}

const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,160}$/;
const CODE_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/;
const DEFAULT_SUPPRESS_MS = 3_600_000;

function bounded(value: string, pattern: RegExp, fallback: string): string {
  return pattern.test(value) ? value : fallback;
}

export function createAlertEmitter(
  log: pino.Logger,
  options: { suppressMs?: number; now?: () => number } = {},
): AlertEmitter {
  const suppressMs = options.suppressMs ?? DEFAULT_SUPPRESS_MS;
  const now = options.now ?? (() => Date.now());
  const active = new Map<string, { lastRaisedAt: number; raisedCount: number }>();

  return {
    raise(alert) {
      const key = bounded(alert.key, KEY_PATTERN, 'invalidAlertKey');
      const code = bounded(alert.code, CODE_PATTERN, 'invalidAlertCode');
      const state = active.get(key);
      const at = now();
      if (state !== undefined && at - state.lastRaisedAt < suppressMs) {
        state.raisedCount += 1;
        return 'suppressed';
      }
      active.set(key, { lastRaisedAt: at, raisedCount: (state?.raisedCount ?? 0) + 1 });
      const line = { alert: 'raised', alertKey: key, severity: alert.severity, code, ...(alert.facts ?? {}) };
      if (alert.severity === 'critical') log.error(line, 'operational alert');
      else log.warn(line, 'operational alert');
      return 'raised';
    },
    clear(key, clearOptions = {}) {
      const boundedKey = bounded(key, KEY_PATTERN, 'invalidAlertKey');
      const wasActive = active.delete(boundedKey);
      if (!wasActive && clearOptions.known !== true) return 'inactive';
      log.info({ alert: 'cleared', alertKey: boundedKey }, 'operational alert cleared');
      return 'cleared';
    },
    activeKeys() {
      return [...active.keys()].sort();
    },
  };
}
