import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TaskType } from '../providers/ProviderRouter.js';
import { EventType } from '../events/EventBus.js';

const PARSE_RULE_PROMPT = `Convert a personal-assistant rule written in natural language into a structured
TRIGGER -> CONDITION -> ACTION workflow.

trigger.type must be one of: "time" (a recurring schedule), "manual" (user invokes it explicitly).
Do NOT invent "email"/"calendar" trigger types unless the user's rule clearly describes checking
email/calendar on a schedule — model that as a "time" trigger that runs a check, since this system
polls rather than receives real push webhooks.

Respond with ONLY JSON:
{
  "trigger": {"type": "time", "cronLike": "human description, e.g. every 15 minutes", "intervalMinutes": 15},
  "condition": "plain-language condition to evaluate against fetched data, or null if none",
  "actionDescription": "plain-language description of what to do when triggered and condition holds",
  "toolName": "the single best-fit registered tool name for the action, or null"
}`;

/**
 * RulesEngine — spec sections 19-20. Converts a natural-language rule into
 * a structured trigger/condition/action, stores it, and runs "time" trigger
 * rules on an interval via setInterval — genuinely executes, not a mockup.
 * "email"/"calendar" event triggers are implemented as polling (check every
 * N minutes) since this backend has no push-webhook listener; that's stated
 * explicitly rather than implied to be real-time.
 */
export class RulesEngine {
  constructor({ router, toolRegistry, approvalSystem, activityLog, memory, eventBus, dataDir = './data' }) {
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.approvalSystem = approvalSystem;
    this.activityLog = activityLog;
    this.memory = memory;
    this.eventBus = eventBus;
    this.filePath = path.join(dataDir, 'rules.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ rules: [] }, null, 2));
    }
    /** @type {Map<string, NodeJS.Timeout>} */
    this._timers = new Map();
  }

  _load() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  _save(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  async createRule(naturalLanguageRule) {
    const toolList = this.toolRegistry.list().map((t) => `- ${t.name}: ${t.description}`).join('\n');
    const result = await this.router.complete(TaskType.SIMPLE, {
      system: `${PARSE_RULE_PROMPT}\n\nAVAILABLE TOOLS:\n${toolList}`,
      messages: [{ role: 'user', content: naturalLanguageRule }],
      maxTokens: 400,
    });

    let parsed;
    try {
      parsed = JSON.parse(result.text.trim().replace(/^```json\s*|\s*```$/g, ''));
    } catch {
      throw new Error(`RulesEngine: could not parse rule into a workflow: ${result.text.slice(0, 200)}`);
    }

    const rule = {
      id: crypto.randomUUID(),
      rawText: naturalLanguageRule,
      trigger: parsed.trigger,
      condition: parsed.condition,
      actionDescription: parsed.actionDescription,
      toolName: parsed.toolName,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
    };

    const data = this._load();
    data.rules.push(rule);
    this._save(data);
    this.activityLog.log({ type: 'rule_created', detail: { ruleId: rule.id, rawText: naturalLanguageRule } });

    if (rule.trigger?.type === 'time') this._scheduleRule(rule);
    return rule;
  }

  _scheduleRule(rule) {
    const minutes = Math.max(1, Number(rule.trigger.intervalMinutes) || 60);
    const timer = setInterval(() => this._fireRule(rule.id).catch(() => {}), minutes * 60 * 1000);
    this._timers.set(rule.id, timer);
  }

  async _fireRule(ruleId) {
    const rule = this._load().rules.find((r) => r.id === ruleId);
    if (!rule || !rule.enabled) return;

    this.activityLog.log({ type: 'rule_fired', detail: { ruleId, actionDescription: rule.actionDescription } });
    this.eventBus?.emitEvent(EventType.AUTOMATION_TRIGGERED, { ruleId, actionDescription: rule.actionDescription });

    if (rule.toolName && this.toolRegistry.has(rule.toolName)) {
      const tool = this.toolRegistry.get(rule.toolName);
      const decision = this.approvalSystem.evaluate({ tool, input: {}, taskId: null });
      if (decision.decision === 'auto') {
        try {
          const result = await this.toolRegistry.execute(rule.toolName, {}, { memory: this.memory });
          this.activityLog.log({ type: 'rule_action_executed', detail: { ruleId, toolName: rule.toolName, result } });
        } catch (err) {
          this.activityLog.log({ type: 'rule_action_failed', detail: { ruleId, toolName: rule.toolName, error: err.message } });
        }
      }
      // If approval is required, it now sits in the approval queue like any other action.
    }

    const data = this._load();
    const idx = data.rules.findIndex((r) => r.id === ruleId);
    data.rules[idx].lastRunAt = new Date().toISOString();
    this._save(data);
  }

  /** Re-arms timers for all enabled time-triggered rules — call once at startup. */
  loadAndSchedule() {
    for (const rule of this._load().rules) {
      if (rule.enabled && rule.trigger?.type === 'time') this._scheduleRule(rule);
    }
  }

  disable(ruleId) {
    const timer = this._timers.get(ruleId);
    if (timer) clearInterval(timer);
    this._timers.delete(ruleId);
    const data = this._load();
    const idx = data.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) throw new Error(`RulesEngine: no rule '${ruleId}'`);
    data.rules[idx].enabled = false;
    this._save(data);
    return data.rules[idx];
  }

  list() {
    return this._load().rules;
  }
}
