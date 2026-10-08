export class ConfigError extends Error {
  readonly missingKeys: string[];
  readonly invalidKeys: string[];

  constructor(message: string, missingKeys: string[], invalidKeys: string[]) {
    super(message);
    this.name = "ConfigError";
    this.missingKeys = missingKeys;
    this.invalidKeys = invalidKeys;
  }
}

export interface AppConfig {
  telegram: {
    botToken: string;
    allowedUserIds: string[];
  };
  llm: {
    primaryProvider: string;
    fallbackProviders: string[];
    apiKeys: Record<string, string>;
    openRouterApiKey?: string;
  };
  agent: {
    maxIterations: number;
    llmTimeoutMs: number;
    llmRetryCount: number;
    llmRetryBaseDelayMs: number;
    toolTimeoutMs: number;
  };
  memory: {
    windowSize: number;
    dbPath: string;
    dbMaxSizeMb: number;
  };
  filesystem: {
    workspaceRoot: string;
    tmpDir: string;
    skillsDir: string;
  };
  logging: {
    logMessageContent: boolean;
  };
  audio: {
    whisperBinary: string;
    whisperModel: string;
    ttsVoiceId: string;
    ffmpegBinary: string;
  };
}

function parseNumber(raw: string | undefined, key: string, fallback: number, invalidKeys: string[]): number {
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    invalidKeys.push(key);
    return fallback;
  }
  return parsed;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true";
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const REQUIRED_VARS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"] as const;

const API_KEY_MAP: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
};

const OPENROUTER_KEY = "OPENROUTER_API_KEY";

export function validateConfig(raw: Record<string, string | undefined>): AppConfig {
  const missingKeys: string[] = [];
  const invalidKeys: string[] = [];

  for (const key of REQUIRED_VARS) {
    if (!raw[key]) {
      missingKeys.push(key);
    }
  }

  const _maxIterations = parseNumber(raw.MAX_ITERATIONS, "MAX_ITERATIONS", 5, invalidKeys);
  const _llmTimeoutMs = parseNumber(raw.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS", 120000, invalidKeys);
  const _llmRetryCount = parseNumber(raw.LLM_RETRY_COUNT, "LLM_RETRY_COUNT", 3, invalidKeys);
  const _llmRetryBaseDelayMs = parseNumber(raw.LLM_RETRY_BASE_DELAY_MS, "LLM_RETRY_BASE_DELAY_MS", 1000, invalidKeys);
  const _toolTimeoutMs = parseNumber(raw.TOOL_TIMEOUT_MS, "TOOL_TIMEOUT_MS", 30000, invalidKeys);
  parseNumber(raw.MEMORY_WINDOW_SIZE, "MEMORY_WINDOW_SIZE", 20, invalidKeys);
  parseNumber(raw.DB_MAX_SIZE_MB, "DB_MAX_SIZE_MB", 500, invalidKeys);

  const primaryProvider = raw.LLM_PROVIDER || "gemini";
  const fallbackProviders = parseCsv(raw.LLM_PROVIDERS).filter((p) => p !== primaryProvider);
  const allProviders = [primaryProvider, ...fallbackProviders];

  const openRouterApiKey = raw[OPENROUTER_KEY] || undefined;

  const apiKeys: Record<string, string> = {};
  if (!openRouterApiKey) {
    for (const provider of allProviders) {
      const keyEnv = API_KEY_MAP[provider];
      if (keyEnv && !raw[keyEnv]) {
        missingKeys.push(keyEnv);
      }
      if (keyEnv) {
        apiKeys[provider] = raw[keyEnv] || "";
      }
    }
  }

  if (missingKeys.length > 0 || invalidKeys.length > 0) {
    const msg =
      `Config validation failed.\n` +
      (missingKeys.length ? `Missing: ${missingKeys.join(", ")}\n` : "") +
      (invalidKeys.length ? `Invalid: ${invalidKeys.join(", ")}` : "");
    throw new ConfigError(msg, missingKeys, invalidKeys);
  }

  const config: AppConfig = {
    telegram: {
      botToken: raw.TELEGRAM_BOT_TOKEN!,
      allowedUserIds: parseCsv(raw.TELEGRAM_ALLOWED_USER_IDS),
    },
    llm: {
      primaryProvider,
      fallbackProviders,
      apiKeys,
      openRouterApiKey,
    },
    agent: {
      maxIterations: _maxIterations,
      llmTimeoutMs: _llmTimeoutMs,
      llmRetryCount: _llmRetryCount,
      llmRetryBaseDelayMs: _llmRetryBaseDelayMs,
      toolTimeoutMs: _toolTimeoutMs,
    },
    memory: {
      windowSize: parseNumber(raw.MEMORY_WINDOW_SIZE, "MEMORY_WINDOW_SIZE", 20, invalidKeys),
      dbPath: raw.DB_PATH || "./data/db.sqlite",
      dbMaxSizeMb: parseNumber(raw.DB_MAX_SIZE_MB, "DB_MAX_SIZE_MB", 500, invalidKeys),
    },
    filesystem: {
      workspaceRoot: raw.WORKSPACE_ROOT || "./output",
      tmpDir: raw.TMP_DIR || "./tmp",
      skillsDir: raw.SKILLS_DIR || "./agents/skills",
    },
    logging: {
      logMessageContent: parseBoolean(raw.LOG_MESSAGE_CONTENT, false),
    },
    audio: {
      whisperBinary: raw.WHISPER_BINARY || "whisper",
      whisperModel: raw.WHISPER_MODEL || "small",
      ttsVoiceId: raw.TTS_VOICE_ID || "pt-BR-ThalitaMultilingualNeural",
      ffmpegBinary: raw.FFMPEG_BINARY || "ffmpeg",
    },
  };

  return Object.freeze(config) as AppConfig;
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    throw new ConfigError("Config not initialized. Call validateConfig first.", [], []);
  }
  return _config;
}

export function setConfig(config: AppConfig): void {
  _config = Object.freeze(config) as AppConfig;
}

export function resetConfig(): void {
  _config = null;
}