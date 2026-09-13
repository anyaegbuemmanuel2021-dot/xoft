const UNHEALTHY_COOLDOWN_MS = 60_000;
const WINDOW_SIZE = 5; // recent-call window used to judge health

// Rough, approximate USD-per-1K-token pricing for cost ESTIMATION only — not
// authoritative billing data. Update if a provider's pricing changes;
// getStats() clearly labels this as an estimate.
const PRICING = {
  openai: { input: 0.005, output: 0.015 },
  openaiFast: { input: 0.00015, output: 0.0006 },
  claude: { input: 0.003, output: 0.015 },
  gemini: { input: 0.000075, output: 0.0003 },
};

/**
 * ModelHealthManager — spec section 9. In-memory (resets on restart, same
 * tradeoff as ActivityLog would make if it buffered — health is inherently
 * about "right now," not history) tracking of provider latency/errors/
 * tokens, used by ProviderRouter to order fallback: healthy configured
 * providers first, unhealthy ones only as a last resort, never skipped
 * entirely (degraded beats dead).
 */
export class ModelHealthManager {
  constructor() {
    /** @type {Map<string, object>} */
    this._stats = new Map();
  }

  _get(providerName) {
    if (!this._stats.has(providerName)) {
      this._stats.set(providerName, {
        recent: [], // last WINDOW_SIZE {ok, ts, errorType?}
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalLatencyMs: 0,
        successCount: 0,
        failureCount: 0,
        unhealthyUntil: 0,
      });
    }
    return this._stats.get(providerName);
  }

  recordSuccess(providerName, { latencyMs, inputTokens = 0, outputTokens = 0 } = {}) {
    const s = this._get(providerName);
    s.recent.push({ ok: true, ts: Date.now() });
    if (s.recent.length > WINDOW_SIZE) s.recent.shift();
    s.totalLatencyMs += latencyMs ?? 0;
    s.totalInputTokens += inputTokens;
    s.totalOutputTokens += outputTokens;
    s.successCount += 1;
  }

  recordFailure(providerName, { errorType = 'unknown' } = {}) {
    const s = this._get(providerName);
    s.recent.push({ ok: false, ts: Date.now(), errorType });
    if (s.recent.length > WINDOW_SIZE) s.recent.shift();
    s.failureCount += 1;
    const recentFailures = s.recent.filter((r) => !r.ok).length;
    if (recentFailures >= 3) {
      s.unhealthyUntil = Date.now() + UNHEALTHY_COOLDOWN_MS;
    }
  }

  isHealthy(providerName) {
    const s = this._stats.get(providerName);
    if (!s) return true; // no data yet — assume healthy until it proves otherwise
    return Date.now() >= s.unhealthyUntil;
  }

  getStats(providerName) {
    const s = this._stats.get(providerName);
    if (!s) return { calls: 0, successCount: 0, failureCount: 0, avgLatencyMs: null, estimatedCostUSD: 0, healthy: true };
    const pricing = PRICING[providerName] ?? { input: 0, output: 0 };
    const estimatedCostUSD = (s.totalInputTokens / 1000) * pricing.input + (s.totalOutputTokens / 1000) * pricing.output;
    return {
      calls: s.successCount + s.failureCount,
      successCount: s.successCount,
      failureCount: s.failureCount,
      avgLatencyMs: s.successCount ? Math.round(s.totalLatencyMs / s.successCount) : null,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      estimatedCostUSD: Number(estimatedCostUSD.toFixed(4)),
      healthy: this.isHealthy(providerName),
    };
  }

  snapshot() {
    const out = {};
    for (const name of this._stats.keys()) out[name] = this.getStats(name);
    return out;
  }
}
