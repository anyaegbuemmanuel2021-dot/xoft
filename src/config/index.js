import dotenv from 'dotenv';
dotenv.config();

function required(name, fallback = undefined) {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(required('PORT', 3000)),
  host: required('HOST', '0.0.0.0'),
  nodeEnv: required('NODE_ENV', 'development'),
  storage: {
    mode: required('STORAGE_MODE', 'sqlite'),
    sqlitePath: required('SQLITE_PATH', './data/xoft.sqlite'),
  },
  production: {
    requireAuth: String(required('REQUIRE_AUTH_IN_PRODUCTION', 'true')).toLowerCase() === 'true',
  },

  memory: {
    dataDir: required('MEMORY_DATA_DIR', './data'),
  },

  devices: {
    // How long without a heartbeat/state update before a device is considered offline.
    onlineThresholdMs: required('DEVICE_ONLINE_THRESHOLD_MS', 90000),
    // How long a device command waits for the agent to report a result before timing out.
    commandTimeoutMs: required('DEVICE_COMMAND_TIMEOUT_MS', 30000),
    // Auto-trust a device that registers from 127.0.0.1/::1 — see isLoopback() in index.js.
    // Off by default; the combined PC launcher (xoft-pc/) turns this on for itself only.
    autoTrustLocal: String(required('AUTO_TRUST_LOCAL', 'false')).toLowerCase() === 'true',
  },

  auth: {
    // Comma-separated shared secrets. Empty = API is open (localhost/LAN dev only — see warning in index.js).
    apiKeys: String(required('AUTH_API_KEYS', ''))
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  },

  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    refreshToken: required('GOOGLE_REFRESH_TOKEN'),
  },

  search: {
    braveApiKey: required('BRAVE_SEARCH_API_KEY'),
  },

  voice: {
    elevenLabsApiKey: required('ELEVENLABS_API_KEY'),
    elevenLabsVoiceId: required('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM'),
  },

  media: {
    // Image generation rides on the OpenAI key already configured above.
    imageModel: required('IMAGE_MODEL', 'gpt-image-2'),
    // Video generation rides on the Gemini key already configured below.
    // 'preview' in the model id reflects Google's own current model name as of this writing —
    // if it changes, calls fail with a real, specific error rather than silently doing nothing.
    videoModel: required('VIDEO_MODEL', 'veo-3.1-generate-preview'),
  },

  connectors: {
    definitions: (() => {
      const raw = process.env.XOFT_CONNECTORS_JSON;
      if (!raw) return [];
      try { return JSON.parse(raw); } catch (err) { throw new Error(`Invalid XOFT_CONNECTORS_JSON: ${err.message}`); }
    })(),
  },

  providers: {
    openai: {
      apiKey: required('OPENAI_API_KEY'),
      chatModel: required('OPENAI_CHAT_MODEL', 'gpt-4.1'),
      fastModel: required('OPENAI_FAST_MODEL', 'gpt-4.1-mini'),
      embeddingModel: required('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
    },
    gemini: {
      apiKey: required('GEMINI_API_KEY'),
      model: required('GEMINI_MODEL', 'gemini-2.0-flash'),
    },
    claude: {
      apiKey: required('ANTHROPIC_API_KEY'),
      model: required('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
    },
  },
};

/**
 * Returns which providers currently have credentials configured.
 * The router uses this to avoid ever pretending a provider works.
 */
export function availableProviders() {
  const avail = [];
  if (config.providers.openai.apiKey) avail.push('openai');
  if (config.providers.gemini.apiKey) avail.push('gemini');
  if (config.providers.claude.apiKey) avail.push('claude');
  return avail;
}

/** Which optional integrations are actually configured — used by /api/status and tool status. */
export function integrationStatus() {
  return {
    google: Boolean(config.google.clientId && config.google.clientSecret && config.google.refreshToken),
    braveSearch: Boolean(config.search.braveApiKey),
    elevenLabs: Boolean(config.voice.elevenLabsApiKey),
    whisper: Boolean(config.providers.openai.apiKey), // STT rides on the OpenAI key
    imageGeneration: Boolean(config.providers.openai.apiKey), // rides on the OpenAI key
    videoGeneration: Boolean(config.providers.gemini.apiKey), // rides on the Gemini key
    connectors: config.connectors.definitions.filter((c) => c.enabled !== false).map((c) => c.id),
  };
}
