const { loadConfig } = require('./config');
const { CoreClient } = require('./coreClient');
const { ensurePaired } = require('./pairing');
const systemExec = require('./executors/system');
const appsExec = require('./executors/applications');
const browserExec = require('./executors/browser');
const filesExec = require('./executors/files');
const mediaExec = require('./executors/media');
const screenExec = require('./executors/screen');

// The only capabilities this agent will ever claim — must match what
// dispatchCommand() actually handles below. Reported to core via
// POST /api/devices/:id/capabilities so commands for anything else are
// never even queued to us (DeviceManager.execute checks this server-side too).
const CAPABILITIES = ['system', 'applications', 'browser', 'files', 'media', 'screen'];

async function dispatchCommand(command, config) {
  const { capability, action, parameters } = command;
  switch (`${capability}.${action}`) {
    case 'system.read_system_info':
      return systemExec.readSystemInfo();
    case 'applications.list':
      return appsExec.listApplications();
    case 'applications.open_application':
      return appsExec.openApplication(parameters.application, config.appAllowlist);
    case 'applications.close_application':
      return appsExec.closeApplication(parameters.application, config.appAllowlist);
    case 'browser.open_url':
      return browserExec.openUrl(parameters.url);
    case 'files.list_files':
      return filesExec.listFiles(parameters.path, config.allowedRoots);
    case 'files.prepare_transfer':
      return filesExec.prepareTransfer(parameters.path, config.allowedRoots);
    case 'files.receive_transfer':
      return filesExec.receiveTransfer(parameters.path, parameters.sourceData, config.allowedRoots);
    case 'screen.capture':
      return screenExec.capture();
    case 'screen.click':
    case 'screen.type':
    case 'screen.scroll':
      return screenExec.input(action, parameters);
    case 'media.play':
    case 'media.pause':
    case 'media.stop':
    case 'media.volume_up':
    case 'media.volume_down':
    case 'media.mute':
      return mediaExec.mediaControl(action);
    default:
      // Honest refusal — never a fabricated success for something we don't implement.
      return { success: false, error: `Agent does not implement ${capability}.${action}.` };
  }
}

async function readReportableState() {
  const info = await systemExec.readSystemInfo();
  if (!info.success) return {};
  return {
    cpu: info.data.loadAverage?.[0] ?? null,
    memory: info.data.memory?.usedPercent ?? null,
    network: info.data.network?.[0]?.address ?? null,
    battery: null, // desktops: no standard battery reading without extra native tooling — reported honestly as unknown, not faked
  };
}

async function pollLoop(client, deviceId, config) {
  let pending;
  try {
    pending = await client.pullPendingCommands(deviceId);
  } catch (err) {
    console.error(`[poll] failed to reach core: ${err.message}`);
    return;
  }
  for (const command of pending) {
    console.log(`[command] ${command.capability}.${command.action} (${command.id})`);
    let result;
    try {
      result = await dispatchCommand(command, config);
    } catch (err) {
      result = { success: false, error: `Unhandled executor error: ${err.message}` };
    }
    try {
      await client.submitResult(deviceId, command.id, result);
    } catch (err) {
      console.error(`[command] failed to submit result for ${command.id}: ${err.message}`);
    }
  }
}

async function main() {
  const config = loadConfig();
  const client = new CoreClient(config.coreUrl, config.apiKey);
  const deviceId = await ensurePaired(config);

  await client.reportCapabilities(deviceId, CAPABILITIES);
  console.log(`Reported capabilities: ${CAPABILITIES.join(', ')}`);

  const heartbeatTick = async () => {
    try {
      await client.heartbeat(deviceId);
    } catch (err) {
      console.error(`[heartbeat] ${err.message}`);
    }
  };
  const stateTick = async () => {
    try {
      await client.reportState(deviceId, await readReportableState());
    } catch (err) {
      console.error(`[state] ${err.message}`);
    }
  };
  const pollTick = () => pollLoop(client, deviceId, config);

  await heartbeatTick();
  await stateTick();
  setInterval(heartbeatTick, config.heartbeatIntervalMs);
  setInterval(stateTick, config.stateReportIntervalMs);
  setInterval(pollTick, config.pollIntervalMs);

  console.log(`\nXOFT Windows agent running. Device id: ${deviceId}`);
  console.log(`Polling ${config.coreUrl} every ${config.pollIntervalMs}ms. Ctrl+C to stop.\n`);
}

main().catch((err) => {
  console.error('Fatal error starting agent:', err.message);
  process.exit(1);
});
