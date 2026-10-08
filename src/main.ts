import dotenv from "dotenv";
import fs from "fs";
import { Bot } from "grammy";
import { execFile } from "child_process";
import { EventEmitter } from "events";
import { validateConfig, setConfig, ConfigError } from "./config.js";
import type { AppConfig } from "./config.js";
import { MemoryManager } from "./memory/memory-manager.js";
import { ToolRegistry } from "./tools/registry.js";
import { CriarArquivoTool, LerArquivoTool, ListarArquivosTool } from "./tools/index.js";
import { ProviderFactory } from "./providers/provider-factory.js";
import { SkillLoader, SkillRouter } from "./skills/index.js";
import { AgentLoop } from "./core/agent-loop.js";
import { AgentController } from "./core/agent-controller.js";
import { TelegramInputHandler } from "./input/input-handler.js";

const SHUTDOWN_TIMEOUT_MS = 10000;

function checkBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("where", [name], { timeout: 5000 }, (err) => {
      resolve(err === null);
    });
  });
}

function checkEdgeTTS(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("edge-tts", ["--version"], { timeout: 5000 }, (err) => {
      resolve(err === null);
    });
  });
}

async function main(): Promise<void> {
  console.info("[Bootstrap] Starting GeneriClaw...");

  dotenv.config();

  let config: AppConfig;
  try {
    config = validateConfig(process.env as Record<string, string | undefined>);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      console.error(`[Bootstrap] Config validation failed:\n${err.message}`);
    } else {
      console.error(`[Bootstrap] Config validation failed: ${err}`);
    }
    process.exit(1);
  }
  setConfig(config);

  const bot = new Bot(config.telegram.botToken);

  try {
    const me = await bot.api.getMe();
    console.info(`[Bootstrap] Bot verified: @${me.username}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Bootstrap] Telegram token validation failed: ${msg}`);
    process.exit(1);
  }

  const ffmpegAvailable = await checkBinary(config.audio.ffmpegBinary);
  if (!ffmpegAvailable) {
    console.warn("[Bootstrap] ffmpeg not found — voice input disabled.");
  }

  const edgeTTSAvailable = await checkEdgeTTS();
  if (!edgeTTSAvailable) {
    console.warn("[Bootstrap] edge-tts not found — voice output disabled.");
  }

  const whisperAvailable = await checkBinary(config.audio.whisperBinary);
  if (!whisperAvailable) {
    console.warn("[Bootstrap] whisper not found — voice input disabled.");
  }

  if (!fs.existsSync("./output")) fs.mkdirSync("./output", { recursive: true });
  if (!fs.existsSync("./data")) fs.mkdirSync("./data", { recursive: true });
  if (!fs.existsSync(config.filesystem.tmpDir)) fs.mkdirSync(config.filesystem.tmpDir, { recursive: true });
  if (!fs.existsSync(config.filesystem.skillsDir)) fs.mkdirSync(config.filesystem.skillsDir, { recursive: true });

  const memoryManager = new MemoryManager({
    dbPath: config.memory.dbPath,
    windowSize: config.memory.windowSize,
    dbMaxSizeMb: config.memory.dbMaxSizeMb,
  });

  try {
    await memoryManager.initialize();
    console.info("[Bootstrap] Database initialized.");
  } catch (err: unknown) {
    console.error(`[Bootstrap] Database initialization failed: ${err}`);
    process.exit(1);
  }

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new CriarArquivoTool(config.filesystem.workspaceRoot));
  toolRegistry.register(new LerArquivoTool(config.filesystem.workspaceRoot));
  toolRegistry.register(new ListarArquivosTool(config.filesystem.workspaceRoot));
  console.info("[Bootstrap] Tools registered.");

  const providerFactory = ProviderFactory.createFromConfig({
    primaryProvider: config.llm.primaryProvider,
    fallbackProviders: config.llm.fallbackProviders,
    apiKeys: config.llm.apiKeys,
    openRouterApiKey: config.llm.openRouterApiKey,
    timeoutMs: config.agent.llmTimeoutMs,
    retryCount: config.agent.llmRetryCount,
    retryBaseDelayMs: config.agent.llmRetryBaseDelayMs,
  });
  console.info("[Bootstrap] Providers registered.");

  const skillLoader = new SkillLoader(config.filesystem.skillsDir, toolRegistry);
  const skills = skillLoader.loadAll();
  console.info(`[Bootstrap] Loaded ${skills.length} skills.`);

  const skillRouter = new SkillRouter(providerFactory);
  console.info("[Bootstrap] SkillRouter ready.");

  const agentLoop = new AgentLoop({
    maxIterations: config.agent.maxIterations,
    toolTimeoutMs: config.agent.toolTimeoutMs,
  });
  console.info("[Bootstrap] AgentLoop ready.");

  const eventEmitter = new EventEmitter();

  const controller = new AgentController({
    memoryManager,
    agentLoop,
    skillRouter,
    skillLoader,
    toolRegistry,
    providerFactory,
    eventEmitter,
    config,
  });
  console.info("[Bootstrap] AgentController ready.");

  const inputHandler = new TelegramInputHandler({
    bot,
    controller,
    config,
  });

  let isShuttingDown = false;

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.info("[Bootstrap] Shutdown signal received.");

    const timeout = setTimeout(() => {
      console.error("[Bootstrap] Shutdown timed out, forcing exit.");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await inputHandler.stop();
      console.info("[Bootstrap] Bot polling stopped.");

      skillLoader.stopWatcher();
      console.info("[Bootstrap] Skill watcher stopped.");

      await controller.shutdown();
      console.info("[Bootstrap] Controller shut down.");

      clearTimeout(timeout);
      console.info("[Bootstrap] Shutdown complete.");
      process.exit(0);
    } catch (err: unknown) {
      clearTimeout(timeout);
      console.error(`[Bootstrap] Shutdown error: ${err}`);
      process.exit(1);
    }
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await inputHandler.start();
    console.info("[Bootstrap] GeneriClaw is running.");
  } catch (err: unknown) {
    console.error(`[Bootstrap] Failed to start bot: ${err}`);
    await shutdown();
  }
}

main().catch((err) => {
  console.error(`[Bootstrap] Fatal error: ${err}`);
  process.exit(1);
});