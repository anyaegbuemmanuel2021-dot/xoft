const fs = require('fs');
const path = require('path');
const os = require('os');

// When packaged with pkg, process.cwd() is where the .exe was launched from
// (not inside the virtual snapshot filesystem) — that's exactly where we
// want config.json and pairing.json to live: next to the executable, edited
// by hand or a future setup wizard.
const BASE_DIR = process.cwd();
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'config.example.json');
const PAIRING_PATH = path.join(BASE_DIR, 'pairing.json');

function expandUsername(str) {
  return typeof str === 'string' ? str.replace(/%USERNAME%/gi, os.userInfo().username) : str;
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const example = fs.readFileSync(EXAMPLE_PATH, 'utf-8');
    fs.writeFileSync(CONFIG_PATH, example);
    console.log(`No config.json found — created one from the template at:\n  ${CONFIG_PATH}`);
    console.log('Edit it (coreUrl, allowedRoots, appAllowlist) before running the agent for real, then run again.');
    process.exit(0);
  }
}

function loadConfig() {
  ensureConfig();
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const allowedRoots = (raw.allowedRoots ?? []).map((p) => path.resolve(expandUsername(p)));
  const appAllowlist = {};
  for (const [name, def] of Object.entries(raw.appAllowlist ?? {})) {
    appAllowlist[name.toLowerCase()] = { path: expandUsername(def.path), processName: def.processName };
  }
  return {
    coreUrl: (raw.coreUrl ?? 'http://localhost:3000').replace(/\/$/, ''),
    apiKey: raw.apiKey || process.env.XOFT_API_KEY || null,
    deviceName: raw.deviceName ?? os.hostname(),
    heartbeatIntervalMs: raw.heartbeatIntervalMs ?? 30000,
    pollIntervalMs: raw.pollIntervalMs ?? 3000,
    stateReportIntervalMs: raw.stateReportIntervalMs ?? 60000,
    allowedRoots,
    appAllowlist,
  };
}

function loadPairing() {
  if (!fs.existsSync(PAIRING_PATH)) return null;
  return JSON.parse(fs.readFileSync(PAIRING_PATH, 'utf-8'));
}

function savePairing(pairing) {
  fs.writeFileSync(PAIRING_PATH, JSON.stringify(pairing, null, 2));
}

module.exports = { loadConfig, loadPairing, savePairing, CONFIG_PATH, PAIRING_PATH };
