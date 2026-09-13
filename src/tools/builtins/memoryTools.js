import { Tool, RiskLevel } from '../Tool.js';

/**
 * Real, working tools backed by MemoryManager. These require a `memory`
 * instance injected via ctx at execution time (the Orchestrator/Planner
 * passes it) — no external credentials, so they always work.
 */
export function buildMemoryTools() {
  return [
    new Tool({
      name: 'remember_fact',
      description: 'Store a fact in long-term memory under a category (person, project, preference, rule, decision, task, fact).',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['category', 'content'],
      },
      riskLevel: RiskLevel.SAFE,
      execute: async ({ category, content }, ctx) => {
        const { longTermId, vectorId } = await ctx.memory.remember(category, content);
        return { stored: true, longTermId, vectorId };
      },
      // Reversible: undo is deleting the exact entry just created.
      computeUndo: (_input, result) =>
        result.longTermId ? { toolName: 'forget_fact_by_id', input: { id: result.longTermId } } : null,
    }),

    new Tool({
      name: 'recall_facts',
      description: 'Search long-term memory by category and/or a text substring.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          textIncludes: { type: 'string' },
        },
      },
      riskLevel: RiskLevel.SAFE,
      execute: async ({ category, textIncludes }, ctx) => {
        const results = ctx.memory.recallStructured({ category, textIncludes });
        return { count: results.length, results };
      },
    }),

    new Tool({
      name: 'forget_facts',
      description: 'Delete facts from memory matching a category and/or text substring.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          textIncludes: { type: 'string' },
        },
      },
      // Deleting memory is reversible-ish (nothing external breaks) but not
      // trivially undoable by the user, so it's LOW rather than SAFE.
      riskLevel: RiskLevel.LOW,
      execute: async ({ category, textIncludes }, ctx) => {
        // Snapshot what's about to be removed BEFORE removing it, so this
        // can be genuinely undone rather than just reporting a count.
        const snapshot = ctx.memory.recallStructured({ category, textIncludes });
        const removed = await ctx.memory.forgetWhere({ category, textIncludes });
        return { removed, _snapshot: snapshot };
      },
      computeUndo: (_input, result) =>
        result._snapshot?.length ? { toolName: 'restore_facts', input: { entries: result._snapshot } } : null,
    }),

    // --- internal tools, used by the rollback system rather than the planner ---
    new Tool({
      name: 'forget_fact_by_id',
      description: 'Delete one specific memory entry by its exact id. Internal — used for rollback, not general use.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      riskLevel: RiskLevel.SAFE,
      execute: async ({ id }, ctx) => ({ removed: await ctx.memory.forgetById(id) }),
    }),

    new Tool({
      name: 'restore_facts',
      description: 'Re-insert a set of previously-removed memory entries. Internal — used for rollback, not general use.',
      inputSchema: {
        type: 'object',
        properties: { entries: { type: 'array', items: { type: 'object' } } },
        required: ['entries'],
      },
      riskLevel: RiskLevel.SAFE,
      execute: async ({ entries }, ctx) => {
        const restoredIds = [];
        for (const entry of entries) {
          const { longTermId } = await ctx.memory.remember(entry.category, entry.content, entry.metadata ?? {});
          restoredIds.push(longTermId);
        }
        return { restoredCount: restoredIds.length, restoredIds };
      },
    }),
  ];
}
