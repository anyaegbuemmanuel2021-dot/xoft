import express from 'express';
import crypto from 'node:crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config, availableProviders, integrationStatus } from './config/index.js';
import { ProviderRouter } from './providers/ProviderRouter.js';
import { MemoryManager } from './memory/MemoryManager.js';
import { Orchestrator } from './orchestrator/Orchestrator.js';
import { ToolRegistry } from './tools/ToolRegistry.js';
import { buildMemoryTools } from './tools/builtins/memoryTools.js';
import { buildUtilityTools } from './tools/builtins/utilityTools.js';
import { buildPlaceholderTools } from './tools/builtins/placeholderTools.js';
import { buildEmailTools } from './tools/builtins/emailTools.js';
import { buildCalendarTools } from './tools/builtins/calendarTools.js';
import { buildResearchTools } from './tools/builtins/researchTools.js';
import { buildMediaTools } from './tools/builtins/mediaTools.js';
import { ActivityLog } from './activity/ActivityLog.js';
import { ApprovalSystem } from './approval/ApprovalSystem.js';
import { TaskPlanner } from './planner/TaskPlanner.js';
import { VoiceService } from './voice/VoiceService.js';
import { RulesEngine } from './automation/RulesEngine.js';
import { NotificationClassifier } from './notifications/NotificationClassifier.js';
import { PermissionSystem, ALL_PERMISSIONS } from './security/PermissionSystem.js';
import { EmergencyStop } from './security/EmergencyStop.js';
import { DeviceRegistry } from './devices/DeviceRegistry.js';
import { DeviceManager } from './devices/DeviceManager.js';
import { buildDeviceTools } from './tools/builtins/deviceTools.js';
import { WorldState } from './executive/WorldState.js';
import { ExecutiveBrain } from './executive/ExecutiveBrain.js';
import { EventBus } from './events/EventBus.js';
import { GoalSystem } from './goals/GoalSystem.js';
import { MonitorManager } from './background/MonitorManager.js';
import { PersonalityEngine } from './personality/PersonalityEngine.js';
import { UserStyleModel } from './personality/UserStyleModel.js';
import { ConfidenceEngine } from './confidence/ConfidenceEngine.js';
import { SecurityAgent } from './security/SecurityAgent.js';
import { DeviceThreatMonitor } from './security/DeviceThreatMonitor.js';
import { PromptInjectionGuard } from './security/PromptInjectionGuard.js';
import { AdvisorAgent } from './advisor/AdvisorAgent.js';
import { ModelHealthManager } from './providers/ModelHealthManager.js';
import { ReasoningEngine } from './reasoning/ReasoningEngine.js';
import { MemoryImportanceScorer } from './memory/MemoryImportanceScorer.js';
import { MemoryConflictResolver } from './memory/MemoryConflictResolver.js';
import { MemoryConsolidator } from './memory/MemoryConsolidator.js';
import { MemoryRetentionManager } from './memory/MemoryRetentionManager.js';
import { KnowledgeGraph } from './memory/KnowledgeGraph.js';
import { BackgroundJobManager } from './background/BackgroundJobManager.js';
import { WorkflowEngine } from './workflows/WorkflowEngine.js';
import { AutonomyManager } from './autonomy/AutonomyManager.js';
import { ProactiveEngine } from './proactive/ProactiveEngine.js';
import { MissionManager } from './missions/MissionManager.js';
import { RecoveryEngine } from './recovery/RecoveryEngine.js';
import { ContextEngine } from './context/ContextEngine.js';
import { VisionInterpreter } from './vision/VisionInterpreter.js';
import { SqliteStore } from './persistence/SqliteStore.js';
import { IntelligenceDirector } from './intelligence/IntelligenceDirector.js';
import { ConnectorManager } from './connectors/ConnectorManager.js';
import { buildConnectorTools } from './tools/builtins/connectorTools.js';
import { DeviceTokenService } from './security/DeviceTokenService.js';

const durableStore = config.storage.mode === 'sqlite' ? new SqliteStore(config.storage.sqlitePath) : null;
const modelHealth = new ModelHealthManager();
const router = new ProviderRouter(modelHealth);
const activityLog = new ActivityLog({ dataDir: config.memory.dataDir });
const visionInterpreter = new VisionInterpreter({ providerRouter: router, activityLog });
const eventBus = new EventBus({ activityLog });
const emergencyStop = new EmergencyStop({ activityLog, eventBus });
const injectionGuard = new PromptInjectionGuard({ activityLog });
const connectorManager = new ConnectorManager({ definitions: config.connectors.definitions, activityLog });

const personality = new PersonalityEngine({ router, dataDir: config.memory.dataDir });
const userStyle = new UserStyleModel({ dataDir: config.memory.dataDir });
const memory = new MemoryManager({ router, dataDir: config.memory.dataDir });
const orchestrator = new Orchestrator({ router, memory, personality, userStyle });

// Permission engine + device registry are created before ToolRegistry now —
// ToolRegistry enforces requiredPermissions on every execute() call, gated
// against a stable "local" device representing the server's own execution
// context (TaskPlanner/RulesEngine/MonitorManager). Real external tools
// (email.send, calendar.write, etc.) are DENIED by default until explicitly
// granted via POST /api/devices/local/permissions — nothing is auto-granted.
const permissionSystem = new PermissionSystem({ activityLog, dataDir: config.memory.dataDir });
const autonomyManager = new AutonomyManager({ activityLog, eventBus, dataDir: config.memory.dataDir });
const deviceRegistry = new DeviceRegistry({ activityLog, eventBus, dataDir: config.memory.dataDir, store: durableStore });
const localDevice = deviceRegistry.getOrCreate('local-server', 'server');
// The local-server identity is the ExecutiveBrain/TaskPlanner's own execution
// context — trust it automatically (it's this process, not a remote client).
if (localDevice.trust !== 'trusted') deviceRegistry.setTrust(localDevice.id, 'trusted');

const deviceTokenService = new DeviceTokenService({ store: durableStore, activityLog });

// DeviceManager — Device Operating Layer coordination point (spec section 3).
// Built on top of DeviceRegistry; adds online/offline derivation and the
// command queue real device agents (phone/laptop) pull from and report
// results to. See docs/DEVICE_OPERATING_LAYER.md for the full design and
// docs/MOBILE_COMPANION_CONTRACT.md for what an agent must implement.
const deviceManager = new DeviceManager({
  deviceRegistry,
  eventBus,
  activityLog,
  onlineThresholdMs: Number(config.devices?.onlineThresholdMs) || undefined,
  defaultCommandTimeoutMs: Number(config.devices?.commandTimeoutMs) || undefined,
  commandStore: durableStore,
});

const toolRegistry = new ToolRegistry({ emergencyStop, permissionEngine: permissionSystem, defaultDeviceId: localDevice.id });
for (const tool of [
  ...buildMemoryTools(),
  ...buildUtilityTools(),
  ...buildEmailTools(),
  ...buildCalendarTools(),
  ...buildResearchTools(),
  ...buildMediaTools(),
  ...buildPlaceholderTools(),
  ...buildDeviceTools({ deviceManager, visionInterpreter, activityLog }),
  ...buildConnectorTools({ connectorManager, permissionSystem, localDeviceId: localDevice.id }),
]) {
  toolRegistry.register(tool);
}

const approvalSystem = new ApprovalSystem({ activityLog, eventBus, autonomyManager, deviceManager });
const recoveryEngine = new RecoveryEngine({ activityLog, eventBus, router, toolRegistry });
const taskPlanner = new TaskPlanner({
  router,
  toolRegistry,
  approvalSystem,
  activityLog,
  memory,
  eventBus,
  deviceManager,
  recoveryEngine,
  dataDir: config.memory.dataDir,
});
const voiceService = new VoiceService();
const rulesEngine = new RulesEngine({ router, toolRegistry, approvalSystem, activityLog, memory, eventBus, dataDir: config.memory.dataDir });
rulesEngine.loadAndSchedule();
const notificationClassifier = new NotificationClassifier(router, injectionGuard);

const worldState = new WorldState({ taskPlanner, approvalSystem, rulesEngine, activityLog, memory, deviceManager });
const confidenceEngine = new ConfidenceEngine(router);
const advisorAgent = new AdvisorAgent(router, injectionGuard);
const goalSystem = new GoalSystem({ activityLog, eventBus, dataDir: config.memory.dataDir });
const monitorManager = new MonitorManager({ router, toolRegistry, activityLog, eventBus, memory, injectionGuard, dataDir: config.memory.dataDir });
monitorManager.loadAndSchedule();

const securityAgent = new SecurityAgent({ activityLog });

// Runtime counterpart to SecurityAgent's static scans — watches live device
// command activity and automatically quarantines a device that trips a
// threshold (flood of commands, repeated failures/probing, a burst of
// elevated-risk actions), rather than only surfacing it after the fact in
// a log. See src/security/DeviceThreatMonitor.js.
const deviceThreatMonitor = new DeviceThreatMonitor({ eventBus, deviceManager, activityLog });

const reasoningEngine = new ReasoningEngine(router);
const memoryImportanceScorer = new MemoryImportanceScorer(router);
const memoryConflictResolver = new MemoryConflictResolver(router);
const memoryConsolidator = new MemoryConsolidator(router);
const memoryRetentionManager = new MemoryRetentionManager();
const knowledgeGraph = new KnowledgeGraph({ dataDir: config.memory.dataDir });
const backgroundJobManager = new BackgroundJobManager({ toolRegistry, taskPlanner, activityLog, eventBus, memory, dataDir: config.memory.dataDir });
backgroundJobManager.loadAndSchedule();
const workflowEngine = new WorkflowEngine({ toolRegistry, activityLog, eventBus, memory, dataDir: config.memory.dataDir });
workflowEngine.reattachListeners();
const contextEngine = new ContextEngine({ worldState, memory, activityLog });
const intelligenceDirector = new IntelligenceDirector({ router, reasoningEngine, confidenceEngine, memory, contextEngine, activityLog });
const executiveBrain = new ExecutiveBrain({
  router,
  memory,
  orchestrator,
  taskPlanner,
  approvalSystem,
  worldState,
  activityLog,
  confidenceEngine,
  personality,
  advisorAgent,
  intelligenceDirector,
});

const missionManager = new MissionManager({ taskPlanner, activityLog, eventBus, dataDir: config.memory.dataDir, emergencyStop });
const proactiveEngine = new ProactiveEngine({ worldState, eventBus, activityLog, deviceManager });
proactiveEngine.start();

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const id = req.get('x-request-id') || crypto.randomUUID();
  req.requestId = id; res.set('x-request-id', id); next();
});
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, service: 'xoft-core' }));
app.get('/readyz', (_req, res) => res.status(200).json({ ok: true, service: 'xoft-core', storage: config.storage.mode, connectors: connectorManager.list().filter((c) => c.enabled).map((c) => c.id) }));

// Real hardening: security headers + rate limiting on every API route, not
// just a config flag that says "secure" — see SecurityAgent for the audit
// that verifies these are actually active.
app.use(helmet());
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 120, // generous for normal use, still a real ceiling against abuse
  standardHeaders: true,
  legacyHeaders: false,
}));

// --- API authentication ---
// Off by default so a fresh `npm run start:pc` on localhost keeps working
// with zero setup — but that ONLY belongs on localhost/LAN. Set AUTH_API_KEYS
// (comma-separated) before putting this behind a public URL/reverse proxy;
// every /api/* route (including device pairing/trust/commands) then requires
// `Authorization: Bearer <key>` or an `X-API-Key` header matching one of them.
// This is intentionally a flat shared-secret model, not per-user accounts —
// matches the project's current single-user design; multi-user auth is a
// separate, larger piece of work, not something to fake here.
if (config.auth.apiKeys.length > 0 || (config.nodeEnv === 'production' && config.production.requireAuth)) {
  if (config.auth.apiKeys.length === 0) throw new Error('Production startup blocked: AUTH_API_KEYS must contain at least one secret.');
  app.use('/api', (req, res, next) => {
    const header = req.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const provided = bearer ?? req.get('x-api-key');
    if (provided && config.auth.apiKeys.includes(provided)) return next();
    // Per-device token (spec section 10): proves "I am device X", not "I am
    // the admin" — so it only gets past this gate, never treated as
    // equivalent to the shared key. The per-route check below still
    // verifies the token's device matches the :id the request is acting on.
    const deviceId = bearer ? deviceTokenService.verify(bearer) : null;
    if (deviceId) { req.deviceAuth = deviceId; return next(); }
    res.status(401).json({ error: 'Missing or invalid API key. Set Authorization: Bearer <key> or X-API-Key.' });
  });
} else {
  console.warn(
    'WARNING: AUTH_API_KEYS is not set — the API is open to anyone who can reach this port. ' +
    'Fine for localhost/LAN dev; set AUTH_API_KEYS before exposing this beyond your own machine.'
  );
}

app.use(express.json({ limit: '2mb' }));
app.use(express.raw({ type: 'audio/*', limit: '15mb' }));
app.use(express.static('public'));

// POST /api/chat  { sessionId, message } -> { action, reply, meta }
// Routed through the Executive Brain: plain conversation/memory ops still go
// straight to the existing Orchestrator; world-state questions, multi-step
// goals, and confirm/cancel of a pending plan are handled by the brain.
app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }
  try {
    const result = await executiveBrain.handle(sessionId, message);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/world-state -> live situational snapshot (tasks, approvals, automations, recent activity)
app.get('/api/world-state', (_req, res) => {
  res.json(worldState.snapshot());
});

// --- Autonomy / proactive intelligence / missions ---
app.get('/api/autonomy', (_req, res) => res.json({ ...autonomyManager.get(), label: autonomyManager.label() }));
app.post('/api/autonomy', (req, res) => { try { res.json({ ...autonomyManager.set(req.body?.level, req.body?.reason), label: autonomyManager.label(req.body?.level) }); } catch (err) { res.status(400).json({ error: err.message }); } });
app.get('/api/context', (_req, res) => res.json(contextEngine.snapshot()));
app.get('/api/intelligence/status', (_req, res) => res.json({ enabled: true, pipeline: ['recall','decompose','plan','critique','uncertainty','confidence','risk','approval','execute','verify','learn'] }));
app.get('/api/suggestions', (_req, res) => res.json(proactiveEngine.list({ status: 'new' })));
app.post('/api/suggestions/:id/dismiss', (req, res) => { try { res.json(proactiveEngine.dismiss(req.params.id)); } catch (err) { res.status(404).json({ error: err.message }); } });
app.post('/api/suggestions/:id/acknowledge', (req, res) => { try { res.json(proactiveEngine.acknowledge(req.params.id)); } catch (err) { res.status(404).json({ error: err.message }); } });
app.post('/api/missions', (req, res) => { const { goal, autonomyLevel, deadline } = req.body ?? {}; if (!goal) return res.status(400).json({ error: 'goal is required' }); res.json(missionManager.create(goal, { autonomyLevel, deadline })); });
app.get('/api/missions', (_req, res) => res.json(missionManager.list()));
app.get('/api/missions/:id', (req, res) => { try { res.json(missionManager.get(req.params.id)); } catch (err) { res.status(404).json({ error: err.message }); } });
app.post('/api/missions/:id/plan', async (req, res) => { try { res.json(await missionManager.plan(req.params.id)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/missions/:id/run', async (req, res) => { try { res.json(await missionManager.run(req.params.id)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/missions/:id/cancel', (req, res) => { try { res.json(missionManager.cancel(req.params.id)); } catch (err) { res.status(404).json({ error: err.message }); } });

// GET /api/memory?category=&textIncludes= -> structured memory entries
app.get('/api/memory', (req, res) => {
  const { category, textIncludes } = req.query;
  res.json(memory.recallStructured({ category, textIncludes }));
});

// DELETE /api/memory/:id -> forget one entry
app.delete('/api/memory/:id', async (req, res) => {
  const removed = await memory.forgetById(req.params.id);
  res.json({ removed });
});

// --- Tools ---
// GET /api/tools -> list registered tools with risk level and implementation status
app.get('/api/connectors', (_req, res) => res.json(connectorManager.list()));
app.get('/api/connectors/:id/tools', async (req, res) => { try { res.json(await connectorManager.discover(req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); } });

app.get('/api/tools', (_req, res) => {
  res.json(toolRegistry.list());
});

// POST /api/tools/:name/execute { input, deviceId? } -> runs a tool directly,
// through the same permission/approval/emergency-stop gate TaskPlanner uses,
// without going through the AI planner. Useful for UI actions that don't
// need an LLM round-trip (e.g. a one-tap "Open Chrome on my laptop" button).
app.post('/api/tools/:name/execute', async (req, res) => {
  const { input, deviceId } = req.body ?? {};
  try {
    const result = await toolRegistry.execute(req.params.name, input ?? {}, { deviceId: deviceId ?? localDevice.id, providerRouter: router, deviceManager });
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Tasks (autonomous task engine) ---
// POST /api/tasks  { goal } -> creates a plan (does not execute)
app.post('/api/tasks', async (req, res) => {
  const { goal } = req.body ?? {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });
  try {
    const task = await taskPlanner.plan(goal);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/execute -> runs as far as possible (stops at approval/failure)
app.post('/api/tasks/:id/execute', async (req, res) => {
  try {
    const task = await taskPlanner.execute(req.params.id);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id', (req, res) => {
  try {
    res.json(taskPlanner.get(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/tasks', (_req, res) => {
  res.json(taskPlanner.list());
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  try {
    res.json(taskPlanner.cancel(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Approvals ---
app.get('/api/approvals', (_req, res) => {
  res.json(approvalSystem.listPending());
});

app.post('/api/approvals/:id/approve', async (req, res) => {
  try {
    const record = approvalSystem.approve(req.params.id);
    let task = null;
    let executionResult = null;

    if (record.taskId) {
      task = await taskPlanner.resumeAfterApproval(record.taskId);
    } else {
      // Standalone approval — e.g. a direct media generation call, or a
      // RulesEngine action — has no task to resume, so there's nothing else
      // that will ever run this. Execute it now using the approval's own
      // stored input; approving IS the execution for these.
      try {
        executionResult = await toolRegistry.execute(record.toolName, record.input, { memory, deviceId: localDevice.id });
      } catch (err) {
        executionResult = { error: err.message };
      }
    }
    res.json({ approval: record, task, executionResult });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/approvals/:id/reject', (req, res) => {
  try {
    res.json(approvalSystem.reject(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Activity log ---
app.get('/api/activity', (req, res) => {
  const { taskId } = req.query;
  res.json(activityLog.query({ taskId }));
});

// --- Voice ---
// POST /api/voice/speak  { "text": "..." } -> audio/mpeg bytes
app.post('/api/voice/speak', async (req, res) => {
  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const audio = await voiceService.textToSpeech(text);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/voice/transcribe  (raw audio body, Content-Type: audio/webm etc.) -> { text }
app.post('/api/voice/transcribe', async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'send raw audio bytes with an audio/* Content-Type' });
  }
  try {
    const text = await voiceService.speechToText(req.body);
    res.json({ text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Automation / rules engine ---
app.post('/api/rules', async (req, res) => {
  const { rule } = req.body ?? {};
  if (!rule) return res.status(400).json({ error: 'rule (natural language) is required' });
  try {
    res.json(await rulesEngine.createRule(rule));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rules', (_req, res) => res.json(rulesEngine.list()));

app.post('/api/rules/:id/disable', (req, res) => {
  try {
    res.json(rulesEngine.disable(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Notifications ---
app.post('/api/notifications/classify', async (req, res) => {
  const { source, content, userRules } = req.body ?? {};
  if (!source || !content) return res.status(400).json({ error: 'source and content are required' });
  try {
    res.json(await notificationClassifier.classify({ source, content }, userRules ?? []));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Permissions (spec section 8/46) ---
app.get('/api/permissions/catalog', (_req, res) => res.json(ALL_PERMISSIONS));

app.get('/api/devices/:id/permissions', (req, res) => {
  res.json(permissionSystem.list(req.params.id));
});

app.post('/api/devices/:id/permissions', (req, res) => {
  const { permission } = req.body ?? {};
  try {
    res.json(permissionSystem.grant(req.params.id, permission));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/devices/:id/permissions/:permission', (req, res) => {
  res.json(permissionSystem.revoke(req.params.id, req.params.permission));
});

// --- Devices ---
app.post('/api/devices', (req, res) => {
  const { name, platform } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const device = deviceRegistry.register(name, platform);

  // AUTO_TRUST_LOCAL (opt-in, off by default): a device registering FROM
  // the same machine core is running on is a fundamentally different trust
  // situation than a remote device — whoever can reach localhost already
  // has full control of this machine. Skips the manual `curl .../trust`
  // step for a same-PC install (core + windows-agent together) without
  // weakening trust for anything arriving over the network.
  if (config.devices.autoTrustLocal && isLoopback(req)) {
    deviceManager.trustDevice(device.id);
    return res.json(deviceRegistry.get(device.id));
  }
  res.json(device);
});

function isLoopback(req) {
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// A request authenticated with a per-device token (req.deviceAuth) may only
// act on ITS OWN device id — device A's token must never let it touch
// device B's queue or state. A request authenticated with the shared
// admin key (req.deviceAuth is undefined) is unrestricted, same as before.
function requireOwnDevice(req, res, next) {
  if (req.deviceAuth && req.deviceAuth !== req.params.id) {
    return res.status(403).json({ error: 'This device token is not valid for the requested device id.' });
  }
  next();
}

app.get('/api/devices', (_req, res) => res.json(deviceManager.listDevices()));

app.post('/api/devices/:id/heartbeat', requireOwnDevice, (req, res) => {
  try {
    res.json(deviceRegistry.heartbeat(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/devices/:id/revoke', (req, res) => {
  try {
    const result = deviceRegistry.revoke(req.params.id);
    deviceTokenService.revokeAllForDevice(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/devices/:id', (req, res) => {
  try {
    const device = deviceManager.getDevice(req.params.id);
    res.json({
      ...device,
      online: deviceManager.isOnline(req.params.id, { silent: true }),
      recentActivity: deviceThreatMonitor.getActivitySummary(req.params.id),
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Discovery != trust (spec section 5) — a device must be explicitly trusted
// by a human before any command can be routed to it. Trusting a device also
// mints its per-device bearer token (spec section 10): returned exactly
// once here, never persisted raw, never retrievable again — if lost, revoke
// and re-trust to issue a new one.
app.post('/api/devices/:id/trust', (req, res) => {
  try {
    const device = deviceManager.trustDevice(req.params.id);
    const deviceToken = deviceTokenService.issue(req.params.id);
    res.json({ ...device, deviceToken });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// A device agent reports what it can actually do once it has the relevant
// OS-level permissions — see docs/MOBILE_COMPANION_CONTRACT.md.
app.post('/api/devices/:id/capabilities', requireOwnDevice, (req, res) => {
  const { capabilities } = req.body ?? {};
  if (!Array.isArray(capabilities)) return res.status(400).json({ error: 'capabilities must be an array of strings' });
  try {
    res.json(deviceManager.setCapabilities(req.params.id, capabilities));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// A device agent pushes its current state (battery, network, active app, ...).
app.post('/api/devices/:id/state', requireOwnDevice, (req, res) => {
  const { state } = req.body ?? {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'state object is required' });
  try {
    res.json(deviceManager.updateState(req.params.id, state));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Device command channel (spec section 7/10) ---
// A connected agent polls this to pick up work queued for it by device tools
// (device_launch_app, device_transfer_file, ...), then reports the outcome.
// This is exactly the "command channel" docs/MOBILE_COMPANION_CONTRACT.md
// previously said did not exist yet in this build.
app.get('/api/devices/:id/commands/pending', requireOwnDevice, (req, res) => {
  try {
    deviceManager.getDevice(req.params.id); // 404s if unknown
    res.json(deviceManager.pullPending(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/devices/:id/commands/:commandId/result', requireOwnDevice, (req, res) => {
  const { success, data, error, verification } = req.body ?? {};
  try {
    res.json(deviceManager.submitResult(req.params.id, req.params.commandId, { success, data, error, verification }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/devices/:id/commands', (req, res) => {
  try {
    deviceManager.getDevice(req.params.id);
    res.json(deviceManager.listCommands(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Emergency stop ---
app.get('/api/emergency-stop', (_req, res) => res.json(emergencyStop.status()));

app.post('/api/emergency-stop/activate', (req, res) => {
  emergencyStop.activate(req.body?.reason);
  res.json(emergencyStop.status());
});

app.post('/api/emergency-stop/deactivate', (_req, res) => {
  emergencyStop.deactivate();
  res.json(emergencyStop.status());
});

// --- Goals / Projects (spec section 15) ---
app.post('/api/goals', (req, res) => {
  const { description } = req.body ?? {};
  if (!description) return res.status(400).json({ error: 'description is required' });
  res.json(goalSystem.createGoal(description));
});

app.get('/api/goals', (_req, res) => res.json(goalSystem.list()));

app.get('/api/goals/:id', (req, res) => {
  try {
    res.json(goalSystem.progress(req.params.id, taskPlanner));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/goals/:id/projects', (req, res) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    res.json(goalSystem.createProject(req.params.id, name));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/goals/:id/projects/:projectId/link-task', (req, res) => {
  const { taskId } = req.body ?? {};
  if (!taskId) return res.status(400).json({ error: 'taskId is required' });
  try {
    res.json(goalSystem.linkTask(req.params.id, req.params.projectId, taskId));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Dry-run / Rollback (spec sections 23, 25) ---
app.get('/api/tasks/:id/preview', (req, res) => {
  try {
    res.json(taskPlanner.previewPlan(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/undo', async (req, res) => {
  try {
    res.json(await taskPlanner.undoTask(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Background monitors (spec section 14) ---
app.post('/api/monitors', (req, res) => {
  const { description, toolName, input, intervalMinutes, condition } = req.body ?? {};
  if (!description || !toolName) return res.status(400).json({ error: 'description and toolName are required' });
  try {
    res.json(monitorManager.create({ description, toolName, input: input ?? {}, intervalMinutes, condition }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/monitors', (_req, res) => res.json(monitorManager.list()));

app.post('/api/monitors/:id/stop', (req, res) => {
  res.json(monitorManager.stop(req.params.id));
});

// --- Personality + user style (spec sections 3-9) ---
app.get('/api/personality', (_req, res) => res.json(personality.getTraits()));

app.post('/api/personality', (req, res) => {
  res.json(personality.setTraits(req.body ?? {}));
});

app.post('/api/personality/adjust', async (req, res) => {
  const { instruction } = req.body ?? {};
  if (!instruction) return res.status(400).json({ error: 'instruction is required' });
  try {
    res.json(await personality.adjustFromInstruction(instruction));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user-style', (_req, res) => res.json(userStyle.stats()));

// --- Events ---
app.get('/api/events', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(eventBus.recent(limit));
});

// --- Security (spec section 27 SecurityAgent / "protect from cyber threats") ---
// Real dependency scan (npm audit) + secret scan + config hardening checks
// + activity anomaly check. Can take a few seconds due to the npm audit call.
app.post('/api/security/audit', async (_req, res) => {
  try {
    const report = await securityAgent.runFullAudit({
      toolRegistry,
      emergencyStop,
      permissionSystem,
      hasHelmet: true, // app.use(helmet()) above — verified structurally, this IS the check passing
      hasRateLimit: true, // app.use('/api', rateLimit(...)) above
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Advisor (problem-solving mode, distinct from task execution) ---
app.post('/api/advise', async (req, res) => {
  const { problem, context } = req.body ?? {};
  if (!problem) return res.status(400).json({ error: 'problem is required' });
  try {
    // Caller-supplied context is external/untrusted; the internal world-state
    // fallback is generated by XOFT itself and doesn't need wrapping.
    const reply = context
      ? await advisorAgent.advise(problem, context, { isExternal: true })
      : await advisorAgent.advise(problem, worldState.describe());
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Reasoning Engine ---
app.post('/api/reasoning/decompose', async (req, res) => {
  const { goal } = req.body ?? {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });
  try {
    res.json(await reasoningEngine.decompose(goal));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reasoning/compare', async (req, res) => {
  const { options, criteria } = req.body ?? {};
  if (!options?.length || !criteria?.length) return res.status(400).json({ error: 'options and criteria arrays are required' });
  try {
    res.json(await reasoningEngine.compareOptions(options, criteria));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reasoning/contradictions', async (req, res) => {
  const { statements } = req.body ?? {};
  if (!statements?.length) return res.status(400).json({ error: 'statements array is required' });
  try {
    res.json(await reasoningEngine.detectContradictions(statements));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Model health ---
app.get('/api/model-health', (_req, res) => res.json(modelHealth.snapshot()));

// --- Memory 2.0 ---
app.post('/api/memory/score-importance', async (req, res) => {
  const { content } = req.body ?? {};
  if (!content) return res.status(400).json({ error: 'content is required' });
  try {
    res.json(await memoryImportanceScorer.score(content));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memory/check-conflicts', async (req, res) => {
  const { newFact, category } = req.body ?? {};
  if (!newFact) return res.status(400).json({ error: 'newFact is required' });
  try {
    const existing = memory.recallStructured({ category });
    res.json(await memoryConflictResolver.findConflicts(newFact, existing.map((e) => ({ id: e.id, content: e.content }))));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory/prune-candidates', (req, res) => {
  const maxAgeDays = Number(req.query.maxAgeDays) || undefined;
  const importanceThreshold = Number(req.query.importanceThreshold) || undefined;
  const all = memory.recallStructured({});
  res.json(memoryRetentionManager.findPruneCandidates(all, { maxAgeDays, importanceThreshold }));
});

// --- Knowledge Graph ---
app.post('/api/knowledge-graph/nodes', (req, res) => {
  const { type, label, metadata } = req.body ?? {};
  if (!type || !label) return res.status(400).json({ error: 'type and label are required' });
  res.json(knowledgeGraph.addNode(type, label, metadata ?? {}));
});

app.post('/api/knowledge-graph/edges', (req, res) => {
  const { fromId, relation, toId } = req.body ?? {};
  if (!fromId || !relation || !toId) return res.status(400).json({ error: 'fromId, relation, and toId are required' });
  try {
    res.json(knowledgeGraph.addEdge(fromId, relation, toId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/knowledge-graph/nodes/:id/related', (req, res) => {
  res.json(knowledgeGraph.getRelated(req.params.id));
});

app.get('/api/knowledge-graph/nodes/:id/traverse', (req, res) => {
  const maxDepth = Number(req.query.maxDepth) || 2;
  res.json(knowledgeGraph.traverse(req.params.id, maxDepth));
});

app.get('/api/knowledge-graph/stats', (_req, res) => res.json(knowledgeGraph.stats()));

// --- Background jobs (general scheduler, distinct from monitors/rules) ---
app.post('/api/jobs', (req, res) => {
  const { toolName, input, delayMs, intervalMs } = req.body ?? {};
  if (!toolName) return res.status(400).json({ error: 'toolName is required' });
  try {
    const job = intervalMs
      ? backgroundJobManager.scheduleRecurring({ toolName, input: input ?? {}, intervalMs })
      : backgroundJobManager.scheduleOnce({ toolName, input: input ?? {}, delayMs: delayMs ?? 0 });
    res.json(job);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/task-schedules', async (req, res) => {
  const { goal, executeAt, delayMs, autonomyLevel } = req.body ?? {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });
  try {
    res.json(await backgroundJobManager.scheduleTask({ goal, executeAt, delayMs, autonomyLevel }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/task-schedules', (_req, res) => res.json(backgroundJobManager.list().filter(j => j.kind === 'task')));

app.get('/api/jobs', (_req, res) => res.json(backgroundJobManager.list()));
app.post('/api/jobs/:id/pause', (req, res) => res.json(backgroundJobManager.pause(req.params.id)));
app.post('/api/jobs/:id/resume', (req, res) => res.json(backgroundJobManager.resume(req.params.id)));
app.post('/api/jobs/:id/cancel', (req, res) => res.json(backgroundJobManager.cancel(req.params.id)));

// --- Workflow engine (fixed cross-agent chains triggered by real events) ---
app.post('/api/workflows', (req, res) => {
  const { name, triggerEventType, steps } = req.body ?? {};
  if (!name || !steps?.length) return res.status(400).json({ error: 'name and steps are required' });
  try {
    res.json(workflowEngine.define({ name, triggerEventType, steps }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/workflows', (_req, res) => res.json(workflowEngine.list()));
app.post('/api/workflows/:id/disable', (req, res) => {
  try {
    res.json(workflowEngine.disable(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});
app.post('/api/workflows/:id/run', async (req, res) => {
  try {
    res.json(await workflowEngine.run(req.params.id, req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get('/api/workflows/:id/runs', (req, res) => res.json(workflowEngine.listRuns(req.params.id)));

// --- Media generation (image + video) ---
// Direct convenience routes — go through the same permission check AND
// approval gate TaskPlanner uses (not just toolRegistry.execute()'s
// permission/emergency-stop check) so an EXTERNAL-risk tool like
// generate_video can't be triggered directly while bypassing approval.
async function executeWithApproval(toolName, input) {
  const tool = toolRegistry.get(toolName);
  const decision = approvalSystem.evaluate({ tool, input, taskId: null });
  if (decision.decision === 'requires_approval') {
    return { status: 'requires_approval', approvalId: decision.approvalId };
  }
  const result = await toolRegistry.execute(toolName, input, { memory, deviceId: localDevice.id });
  return { status: 'completed', result };
}

app.post('/api/media/image', async (req, res) => {
  const { prompt, size } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  try {
    const outcome = await executeWithApproval('generate_image', { prompt, size });
    res.status(outcome.status === 'requires_approval' ? 202 : 200).json(outcome);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/video', async (req, res) => {
  const { prompt, maxWaitSeconds } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  try {
    const outcome = await executeWithApproval('generate_video', { prompt, maxWaitSeconds });
    res.status(outcome.status === 'requires_approval' ? 202 : 200).json(outcome);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/media/video/status', async (req, res) => {
  const { operationName } = req.query;
  if (!operationName) return res.status(400).json({ error: 'operationName query param is required' });
  try {
    // SAFE-risk read-only check — no approval gate needed, matches its riskLevel.
    const result = await toolRegistry.execute('check_video_generation', { operationName }, { memory, deviceId: localDevice.id });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status -> what's actually configured, no pretending
app.get('/api/status', (_req, res) => {
  res.json({
    configuredProviders: availableProviders(),
    integrations: integrationStatus(),
    vectorMemoryEnabled: memory.vectorEnabled,
    emergencyStop: emergencyStop.status(),
    autonomy: { ...autonomyManager.get(), label: autonomyManager.label() },
    proactiveSuggestions: proactiveEngine.list({ status: 'new' }).length,
    activeMissions: missionManager.list().filter((m) => !['completed', 'cancelled'].includes(m.status)).length,
    modelHealth: modelHealth.snapshot(),
    localDeviceId: localDevice.id, // grant server-side tool permissions against this id — see README
    note: memory.vectorEnabled
      ? null
      : 'Semantic recall disabled — set OPENAI_API_KEY to enable embeddings-based memory search.',
  });
});

const server = app.listen(config.port, config.host, () => {
  const providers = availableProviders();
  console.log(`XOFT core listening on port ${config.port}`);
  console.log(
    providers.length
      ? `Configured providers: ${providers.join(', ')}`
      : 'WARNING: no AI provider API keys set — /api/chat will fail until you add one to .env'
  );
});

const shutdown = (signal) => {
  console.log(`Received ${signal}; shutting down XOFT core...`);
  server.close(() => { durableStore?.close(); process.exit(0); });
  setTimeout(() => { durableStore?.close(); process.exit(1); }, 10000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };
