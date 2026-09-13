import crypto from 'node:crypto';
import { RiskLevel } from '../tools/Tool.js';
import { EventType } from '../events/EventBus.js';

/**
 * ApprovalSystem — implements spec sections 14-16.
 *
 * Decision rule:
 *   SAFE (0)          -> always auto-executes
 *   LOW (1)           -> auto-executes unless user config sets autoApproveLow=false
 *   EXTERNAL (2)      -> requires approval unless user config explicitly allowlists it
 *   HIGH_IMPACT (3)   -> ALWAYS requires approval, no config can override this
 *
 * This never asks "should I do this?" for level 0/1 — see spec section 15
 * ("ask only when necessary"). It only interrupts for level 2/3.
 */
export class ApprovalSystem {
  /**
   * @param {object} opts
   * @param {import('../activity/ActivityLog.js').ActivityLog} opts.activityLog
   * @param {{autoApproveLow?:boolean, autoApproveExternalTools?:string[]}} [opts.userSettings]
   */
  constructor({ activityLog, eventBus, userSettings = {}, autonomyManager, deviceManager } = {}) {
    this.activityLog = activityLog;
    this.eventBus = eventBus;
    this.autonomyManager = autonomyManager ?? null;
    this.deviceManager = deviceManager ?? null;
    this.userSettings = {
      autoApproveLow: userSettings.autoApproveLow ?? true,
      autoApproveExternalTools: new Set(userSettings.autoApproveExternalTools ?? []),
    };
    /** @type {Map<string, {id:string, toolName:string, input:object, riskLevel:number, status:string, createdAt:string, taskId:string|null}>} */
    this.pending = new Map();
  }

  /**
   * Decides whether a given tool call can proceed immediately or must wait
   * for approval. Does NOT execute anything — pure decision.
   * @returns {{decision:'auto'|'requires_approval', approvalId?:string}}
   */
  evaluate({ tool, input, taskId = null }) {
    const level = tool.riskLevel;

    if (level === RiskLevel.SAFE) {
      return { decision: 'auto' };
    }

    if (level === RiskLevel.LOW) {
      if (this.userSettings.autoApproveLow) return { decision: 'auto' };
      if (this.autonomyManager?.canAutoExecute({ riskLevel: level })) return { decision: 'auto' };
    }

    if (level === RiskLevel.EXTERNAL) {
      if (this.userSettings.autoApproveExternalTools.has(tool.name)) return { decision: 'auto' };
      const targetDeviceId = input?.deviceId ?? input?.targetDeviceId ?? input?.sourceDeviceId;
      const trusted = Boolean(targetDeviceId && (input?.deviceTrusted === true || this.deviceManager?.getDevice?.(targetDeviceId)?.trust === 'trusted'));
      if (this.autonomyManager?.canAutoExecute({ riskLevel: level, trusted, mission: Boolean(input?.missionId) })) return { decision: 'auto' };
    }

    // LOW (with autoApprove off), EXTERNAL (not allowlisted), and HIGH_IMPACT
    // (always) all land here.
    const approvalId = crypto.randomUUID();
    this.pending.set(approvalId, {
      id: approvalId,
      toolName: tool.name,
      input,
      riskLevel: level,
      status: 'pending',
      createdAt: new Date().toISOString(),
      taskId,
    });
    this.activityLog.log({
      type: 'approval_requested',
      taskId,
      toolName: tool.name,
      detail: { approvalId, riskLevel: level, input },
    });
    this.eventBus?.emitEvent(EventType.APPROVAL_REQUIRED, { approvalId, taskId, toolName: tool.name, riskLevel: level });
    return { decision: 'requires_approval', approvalId };
  }

  approve(approvalId) {
    const record = this.pending.get(approvalId);
    if (!record) throw new Error(`ApprovalSystem: no pending approval '${approvalId}'`);
    record.status = 'approved';
    this.activityLog.log({ type: 'approval_granted', taskId: record.taskId, toolName: record.toolName, detail: { approvalId } });
    return record;
  }

  reject(approvalId) {
    const record = this.pending.get(approvalId);
    if (!record) throw new Error(`ApprovalSystem: no pending approval '${approvalId}'`);
    record.status = 'rejected';
    this.activityLog.log({ type: 'approval_denied', taskId: record.taskId, toolName: record.toolName, detail: { approvalId } });
    return record;
  }

  get(approvalId) {
    return this.pending.get(approvalId) ?? null;
  }

  listPending() {
    return [...this.pending.values()].filter((r) => r.status === 'pending');
  }
}
