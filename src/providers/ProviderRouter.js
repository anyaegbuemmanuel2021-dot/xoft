import { OpenAIProvider } from './OpenAIProvider.js';
import { GeminiProvider } from './GeminiProvider.js';
import { ClaudeProvider } from './ClaudeProvider.js';

/**
 * Task types the router understands. Callers (Orchestrator, agents) pass one
 * of these instead of naming a model — the router decides which configured
 * provider actually handles it.
 */
export const TaskType = {
  SIMPLE: 'simple', // quick classification, short replies -> cheap/fast model
  REASONING: 'reasoning', // multi-step planning, complex judgement -> strongest model
  CODING: 'coding', // code generation/debugging
  LONG_CONTEXT: 'long_context', // large documents
  RESEARCH: 'research', // paired with web search tool results
  EMBEDDING: 'embedding', // vector memory
};

export class ProviderRouter {
  /** @param {import('./ModelHealthManager.js').ModelHealthManager} [healthManager] */
  constructor(healthManager) {
    // Instantiated lazily so missing API keys don't throw at import time.
    this._instances = {
      openai: new OpenAIProvider(),
      openaiFast: new OpenAIProvider({ fast: true }),
      gemini: new GeminiProvider(),
      claude: new ClaudeProvider(),
    };
    this.healthManager = healthManager ?? null;
  }

  /** Ordered preference list per task type. First configured provider wins. */
  _preferenceFor(taskType) {
    switch (taskType) {
      case TaskType.SIMPLE:
        return [this._instances.openaiFast, this._instances.gemini, this._instances.claude];
      case TaskType.REASONING:
        return [this._instances.claude, this._instances.openai, this._instances.gemini];
      case TaskType.CODING:
        return [this._instances.claude, this._instances.openai, this._instances.gemini];
      case TaskType.LONG_CONTEXT:
        return [this._instances.gemini, this._instances.claude, this._instances.openai];
      case TaskType.RESEARCH:
        return [this._instances.claude, this._instances.openai, this._instances.gemini];
      default:
        return [this._instances.openai, this._instances.claude, this._instances.gemini];
    }
  }

  /**
   * Picks the first configured (has API key) provider for the task type.
   * Throws a clear, specific error if none are configured — never silently
   * falls back to a fake response.
   */
  select(taskType) {
    const candidates = this._preferenceFor(taskType);
    const chosen = candidates.find((p) => p.isConfigured());
    if (!chosen) {
      const names = candidates.map((p) => p.name).join(', ');
      throw new Error(
        `ProviderRouter: no configured provider available for task '${taskType}'. ` +
          `Tried: ${names}. Set at least one API key in .env.`
      );
    }
    return chosen;
  }

  /** Provider used specifically for embeddings (vector memory). */
  selectEmbedding() {
    const p = this._instances.openai;
    if (!p.isConfigured()) {
      throw new Error('ProviderRouter: embeddings require OPENAI_API_KEY (only provider wired for embed()).');
    }
    return p;
  }

  /**
   * Provider used specifically for image/screenshot understanding.
   * Only Claude and OpenAI accept image content blocks in this codebase's
   * provider implementations — GeminiProvider.complete() currently forces
   * every message part to `{ text: m.content }` and has no image branch, so
   * it is deliberately excluded here rather than silently mishandling image
   * input. If Gemini vision support is added to GeminiProvider later, add
   * it to this list.
   */
  selectVision() {
    const candidates = [this._instances.claude, this._instances.openai].filter((p) => p.isConfigured());
    if (!candidates.length) {
      throw new Error(
        'ProviderRouter: no vision-capable provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY. ' +
          '(Gemini is not wired for image input in this codebase.)'
      );
    }
    return candidates[0];
  }

  getProvider(name) {
    const provider = this._instances[name];
    if (!provider) throw new Error(`ProviderRouter: unknown provider '${name}'`);
    if (!provider.isConfigured()) throw new Error(`ProviderRouter: provider '${name}' is not configured`);
    return provider;
  }

  async complete(taskType, params) {
    const candidates = this._preferenceFor(taskType).filter((p) => p.isConfigured());
    if (candidates.length === 0) {
      const names = this._preferenceFor(taskType).map((p) => p.name).join(', ');
      throw new Error(
        `ProviderRouter: no configured provider available for task '${taskType}'. ` +
          `Tried: ${names}. Set at least one API key in .env.`
      );
    }

    // Controlled fallback: try healthy configured candidates first, then
    // unhealthy configured ones as a last resort (degraded beats dead) —
    // each provider is tried at most once per call, so this is bounded by
    // the number of configured candidates, never an infinite retry loop.
    const healthy = candidates.filter((p) => this.healthManager?.isHealthy(p.name) ?? true);
    const unhealthy = candidates.filter((p) => !(this.healthManager?.isHealthy(p.name) ?? true));
    const tryOrder = [...healthy, ...unhealthy];

    let lastError;
    for (const provider of tryOrder) {
      const start = Date.now();
      try {
        const result = await provider.complete(params);
        this.healthManager?.recordSuccess(provider.name, {
          latencyMs: Date.now() - start,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        });
        return result;
      } catch (err) {
        const errorType = /rate.?limit|429/i.test(err.message)
          ? 'rate_limit'
          : /timeout|ETIMEDOUT/i.test(err.message)
            ? 'timeout'
            : /401|403|auth/i.test(err.message)
              ? 'auth'
              : 'unknown';
        this.healthManager?.recordFailure(provider.name, { errorType });
        lastError = err;
      }
    }
    throw new Error(`ProviderRouter: all configured providers failed for task '${taskType}'. Last error: ${lastError?.message}`);
  }

  configuredProviders() {
    return Object.values(this._instances)
      .filter((p) => p.isConfigured())
      .map((p) => p.name);
  }
}
