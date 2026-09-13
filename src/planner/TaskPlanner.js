import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TaskType } from '../providers/ProviderRouter.js';
import { EventType } from '../events/EventBus.js';

const PLANNING_SYSTEM_PROMPT = `You are a task planner for a personal AI assistant.
Given a goal and a list of available tools, break the goal into the smallest number of
concrete steps needed, each using exactly one available tool. Respect dependencies —
a step that needs another step's output must list that step's id in "dependsOn".

Only use tools from the provided list. If the goal cannot be accomplished with the
available tools, return an empty "steps" array and explain why in "blockedReason".

If a step targets a device (a tool with a "deviceId" input), you MUST use the real
device id from the KNOWN DEVICES list below — never invent one, and never use a device
name as if it were an id. If the goal names a device that isn't in the list, or the list
is empty, leave steps empty and explain that in "blockedReason" instead of guessing.

Respond with ONLY JSON, no markdown fences:
{
  "steps": [
    {"id": "step1", "toolName": "...", "input": {...}, "dependsOn": [], "description": "..."}
  ],
  "blockedReason": null
}`;

const MAX_RETRIES_PER_STEP = 2;

/**
 * TaskPlanner — implements spec sections 11 (autonomous task engine) and
 * 17 (error recovery): goal -> plan -> dependency-ordered execution ->
 * per-step verification -> bounded retry -> completion/failure report.
 *
 * Tasks and their step results persist to disk so `GET /api/tasks/:id`
 * reflects real state even after a restart.
 */
export class TaskPlanner {
  /**
   * @param {object} deps
   * @param {import('../providers/ProviderRouter.js').ProviderRouter} deps.router
   * @param {import('../tools/ToolRegistry.js').ToolRegistry} deps.toolRegistry
   * @param {import('../approval/ApprovalSystem.js').ApprovalSystem} deps.approvalSystem
   * @param {import('../activity/ActivityLog.js').ActivityLog} deps.activityLog
   * @param {import('../memory/MemoryManager.js').MemoryManager} deps.memory
   * @param {import('../devices/DeviceManager.js').DeviceManager} [deps.deviceManager]
   * @param {string} deps.dataDir
   */
  constructor({ router, toolRegistry, approvalSystem, activityLog, memory, eventBus, deviceManager, recoveryEngine, dataDir = './data' }) {
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.approvalSystem = approvalSystem;
    this.activityLog = activityLog;
    this.memory = memory;
    this.eventBus = eventBus;
    this.deviceManager = deviceManager ?? null;
    this.recoveryEngine = recoveryEngine ?? null;
    this.filePath = path.join(dataDir, 'tasks.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ tasks: [] }, null, 2));
    }
  }

  _load() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  _save(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  _getTask(taskId) {
    const task = this._load().tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`TaskPlanner: no task '${taskId}'`);
    return task;
  }

  _updateTask(taskId, updater) {
    const data = this._load();
    const idx = data.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) throw new Error(`TaskPlanner: no task '${taskId}'`);
    data.tasks[idx] = updater(data.tasks[idx]);
    this._save(data);
    return data.tasks[idx];
  }

  /**
   * Creates a plan for a goal using available tools, but does not execute it.
   * @param {string} goal
   * @returns {Promise<object>} the created task record
   */
  async plan(goal) {
    const toolSchemas = this.toolRegistry.schemasForAI();
    const toolList = toolSchemas
      .map((t) => `- ${t.name}: ${t.description} | input: ${JSON.stringify(t.inputSchema)}`)
      .join('\n');

    // KNOWN DEVICES — real ids only, so the planner can never invent one for
    // a device-targeting tool (spec section 11 ExecutiveBrain integration).
    // Only trusted devices are listed; untrusted ones can't receive commands
    // anyway (DeviceManager.execute enforces that independently as a second gate).
    const devices = this.deviceManager?.listDevices().filter((d) => d.platform !== 'server' && d.trust === 'trusted') ?? [];
    const deviceList = devices.length
      ? devices.map((d) => `- id: ${d.id} | name: "${d.name}" | platform: ${d.platform} | online: ${d.online} | capabilities: [${d.capabilities.join(', ')}]`).join('\n')
      : 'No trusted devices are currently registered.';

    const result = await this.router.complete(TaskType.REASONING, {
      system: `${PLANNING_SYSTEM_PROMPT}\n\nAVAILABLE TOOLS:\n${toolList}\n\nKNOWN DEVICES:\n${deviceList}`,
      messages: [{ role: 'user', content: `Goal: ${goal}` }],
      maxTokens: 1500,
    });

    let parsed;
    try {
      const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, '');
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`TaskPlanner: planner model returned non-JSON output: ${result.text.slice(0, 200)}`);
    }

    const taskId = crypto.randomUUID();
    const steps = (parsed.steps ?? []).map((s) => ({
      ...s,
      status: 'pending', // pending | waiting_approval | running | completed | failed | blocked | rolled_back
      result: null,
      error: null,
      attempts: 0,
      undo: null,
    }));

    const task = {
      id: taskId,
      goal,
      status: steps.length ? 'planned' : 'blocked',
      blockedReason: parsed.blockedReason ?? null,
      steps,
      createdAt: new Date().toISOString(),
    };

    const data = this._load();
    data.tasks.push(task);
    this._save(data);

    this.activityLog.log({ type: 'task_created', taskId, detail: { goal, stepCount: steps.length } });
    return task;
  }

  /**
   * Executes as much of a planned task's step graph as currently possible,
   * stopping cleanly at the first step that needs approval or has
   * exhausted its retries.
   * @param {string} taskId
   */
  async execute(taskId) {
    let task = this._getTask(taskId);
    if (task.status === 'blocked') return task;

    task = this._updateTask(taskId, (t) => ({ ...t, status: 'running' }));

    for (const step of task.steps) {
      if (step.status === 'completed') continue;

      const dependenciesDone = step.dependsOn.every(
        (depId) => task.steps.find((s) => s.id === depId)?.status === 'completed'
      );
      if (!dependenciesDone) {
        task = this._updateTask(taskId, (t) => ({ ...t, status: 'blocked' }));
        break;
      }

      const stepResult = await this._runStep(taskId, step);
      task = this._getTask(taskId);

      if (stepResult.status === 'waiting_approval') {
        task = this._updateTask(taskId, (t) => ({ ...t, status: 'waiting_approval' }));
        break;
      }
      if (stepResult.status === 'failed') {
        task = this._updateTask(taskId, (t) => ({ ...t, status: 'failed' }));
        this.eventBus?.emitEvent(EventType.TASK_FAILED, { taskId, goal: task.goal });
        break;
      }
    }

    task = this._getTask(taskId);
    if (task.steps.every((s) => s.status === 'completed')) {
      task = this._updateTask(taskId, (t) => ({ ...t, status: 'completed' }));
      this.activityLog.log({ type: 'task_completed', taskId });
      this.eventBus?.emitEvent(EventType.TASK_COMPLETED, { taskId, goal: task.goal });
    }
    return task;
  }

  /** Runs a single step: approval check -> execute -> verify -> retry-on-failure. */
  /**
   * Runs a single step: checks a previously-issued approval before
   * re-evaluating risk, so resuming after approval doesn't mint a fresh
   * approval request and chase its own tail. Only evaluates risk fresh
   * for a step that hasn't been through approval before.
   */
  async _runStep(taskId, step) {
    const tool = this.toolRegistry.get(step.toolName);

    if (step.status === 'waiting_approval' && step.approvalId) {
      const record = this.approvalSystem.get(step.approvalId);
      if (record?.status === 'approved') {
        return this._executeStep(taskId, step, tool);
      }
      if (record?.status === 'rejected') {
        this._patchStep(taskId, step.id, { status: 'failed', error: 'approval rejected' });
        this.activityLog.log({ type: 'task_failed', taskId, toolName: tool.name, detail: { error: 'approval rejected' } });
        return { status: 'failed', error: 'approval rejected' };
      }
      return { status: 'waiting_approval' }; // still pending, nothing new to do
    }

    const decision = this.approvalSystem.evaluate({ tool, input: step.input, taskId });

    if (decision.decision === 'requires_approval') {
      this._patchStep(taskId, step.id, { status: 'waiting_approval', approvalId: decision.approvalId });
      return { status: 'waiting_approval' };
    }

    return this._executeStep(taskId, step, tool);
  }

  async _executeStep(taskId, step, tool) {
    this._patchStep(taskId, step.id, { status: 'running' });
    try {
      const result = await this.toolRegistry.execute(tool.name, step.input, { memory: this.memory, providerRouter: this.router, deviceManager: this.deviceManager });
      this.activityLog.log({ type: 'tool_executed', taskId, toolName: tool.name, detail: { input: step.input, result } });
      const undo = tool.computeUndo ? tool.computeUndo(step.input, result) : null;
      this._patchStep(taskId, step.id, { status: 'completed', result, error: null, undo, verification: result?.verification ?? null });
      return { status: 'completed', result };
    } catch (err) {
      const attempts = (step.attempts ?? 0) + 1;
      this.activityLog.log({ type: 'tool_failed', taskId, toolName: tool.name, detail: { attempt: attempts, error: err.message } });

      if (attempts <= MAX_RETRIES_PER_STEP) {
        // Adaptive recovery: diagnose the failure and choose a bounded strategy.
        // Device restart remains the first safe recovery for app-specific failures;
        // otherwise the planner may choose an existing equal/lower-risk tool.
        if (this.recoveryEngine) {
          try {
            const recovery = await this.recoveryEngine.chooseStrategy({ goal: this._getTask(taskId).goal, step, error: err });
            this._patchStep(taskId, step.id, { lastRecovery: recovery });
            if (recovery.strategy === 'abort') {
              this._patchStep(taskId, step.id, { status: 'failed', attempts, error: err.message, recoveryDecision: recovery.reason });
              return { status: 'failed', error: err.message };
            }
            if (recovery.strategy === 'restart_app' && step.input?.deviceId && step.input?.application) {
              const deviceRecovery = await this.recoveryEngine.recoverDeviceStep({ deviceManager: this.deviceManager, deviceId: step.input.deviceId, application: step.input.application, toolName: tool.name, error: err, attempt: attempts });
              this._patchStep(taskId, step.id, { recovery: deviceRecovery.actions ?? [], lastRecovery: { ...recovery, deviceRecovery } });
            } else if (recovery.strategy === 'retry_with_adjusted_input') {
              step.input = { ...step.input, ...recovery.inputPatch };
              this._patchStep(taskId, step.id, { input: step.input });
            } else if (recovery.strategy === 'alternative_tool' && recovery.toolName) {
              const alternative = this.toolRegistry.get(recovery.toolName);
              if (alternative.riskLevel <= tool.riskLevel) {
                tool = alternative;
                step.toolName = alternative.name;
                step.input = { ...step.input, ...recovery.inputPatch };
                this._patchStep(taskId, step.id, { toolName: alternative.name, input: step.input });
              } else {
                recovery.strategy = 'abort';
                recovery.reason = 'alternative tool would increase risk';
              }
            }
          } catch (recoveryErr) {
            this.activityLog.log({ type: 'recovery_failed', taskId, toolName: tool.name, detail: { error: recoveryErr.message } });
          }
        }
        try {
          await this.memory?.remember?.('execution_failure', `Task ${taskId}, tool ${tool.name} failed on attempt ${attempts}: ${err.message}`, { taskId, toolName: tool.name, error: err.message, attempt: attempts });
        } catch { /* learning must never break execution */ }
        this._patchStep(taskId, step.id, { status: 'pending', attempts, error: err.message });
        return this._executeStep(taskId, { ...step, attempts }, tool);
      }

      try {
        await this.memory?.remember?.('execution_failure', `Task ${taskId}, tool ${tool.name} exhausted retries: ${err.message}`, { taskId, toolName: tool.name, error: err.message, attempts });
      } catch { /* learning must never break execution */ }
      this._patchStep(taskId, step.id, { status: 'failed', attempts, error: err.message });
      this.activityLog.log({ type: 'task_failed', taskId, toolName: tool.name, detail: { error: err.message } });
      return { status: 'failed', error: err.message };
    }
  }

  _patchStep(taskId, stepId, patch) {
    this._updateTask(taskId, (t) => ({
      ...t,
      steps: t.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    }));
  }

  /** Call after an approval is granted to resume execution from where it stopped. */
  async resumeAfterApproval(taskId) {
    return this.execute(taskId);
  }

  /**
   * Dry-run — spec section 23. Builds a human-readable plan preview and risk
   * summary WITHOUT executing anything. Shared by ExecutiveBrain's
   * confirmation flow and the standalone preview API so there's one source
   * of truth for what "the plan" means.
   */
  previewPlan(taskId) {
    const task = this._getTask(taskId);
    const RiskNames = { 0: 'SAFE', 1: 'LOW', 2: 'EXTERNAL', 3: 'HIGH_IMPACT' };
    const stepPreviews = task.steps.map((s) => {
      const tool = this.toolRegistry.get(s.toolName);
      return { description: s.description, toolName: s.toolName, riskLevel: tool.riskLevel, riskName: RiskNames[tool.riskLevel] };
    });
    const maxRisk = stepPreviews.length ? Math.max(...stepPreviews.map((s) => s.riskLevel)) : 0;
    return {
      taskId,
      goal: task.goal,
      steps: stepPreviews,
      maxRisk,
      maxRiskName: RiskNames[maxRisk],
      requiresApproval: maxRisk >= 2, // EXTERNAL or HIGH_IMPACT
      text: stepPreviews.map((s, i) => `${i + 1}. ${s.description} (${s.riskName})`).join('\n'),
    };
  }

  /**
   * Rollback — spec section 25. Reverses completed steps in reverse order,
   * for whichever ones actually have undo info (recorded at execution time
   * from the tool's own computeUndo). Steps without a computeUndo are
   * skipped and reported as not-reversible rather than silently ignored.
   */
  async undoTask(taskId) {
    const task = this._getTask(taskId);
    const completedWithUndo = [...task.steps].reverse().filter((s) => s.status === 'completed');
    const results = [];

    for (const step of completedWithUndo) {
      if (!step.undo) {
        results.push({ stepId: step.id, description: step.description, reversed: false, reason: 'not reversible' });
        continue;
      }
      try {
        await this.toolRegistry.execute(step.undo.toolName, step.undo.input, { memory: this.memory });
        this._patchStep(taskId, step.id, { status: 'rolled_back' });
        this.activityLog.log({ type: 'step_rolled_back', taskId, toolName: step.toolName, detail: { undoTool: step.undo.toolName } });
        results.push({ stepId: step.id, description: step.description, reversed: true });
      } catch (err) {
        this.activityLog.log({ type: 'rollback_failed', taskId, toolName: step.toolName, detail: { error: err.message } });
        results.push({ stepId: step.id, description: step.description, reversed: false, reason: err.message });
      }
    }

    const allReversedOrSkippedCleanly = results.every((r) => r.reversed || r.reason === 'not reversible');
    this._updateTask(taskId, (t) => ({ ...t, status: allReversedOrSkippedCleanly ? 'rolled_back' : 'rollback_partial' }));
    return { taskId, results };
  }

  get(taskId) {
    return this._getTask(taskId);
  }

  list() {
    return this._load().tasks;
  }

  cancel(taskId) {
    const task = this._updateTask(taskId, (t) => ({
      ...t,
      status: 'cancelled',
      steps: t.steps.map((s) => (s.status === 'pending' || s.status === 'waiting_approval' ? { ...s, status: 'cancelled' } : s)),
    }));
    this.activityLog.log({ type: 'task_cancelled', taskId });
    return task;
  }
}
