import dotenv from "dotenv";
import fs from "fs";
import { Bot } from "grammy";
import { execFile } from "child_process";
import { validateConfig, ConfigError } from "./config.js";
import type { AppConfig } from "./config.js";
import { MemoryManager } from "./memory/memory-manager.js";
import { ToolRegistry } from "./tools/registry.js";
import { CriarArquivoTool, LerArquivoTool, ListarArquivosTool } from "./tools/index.js";
import { HistoricoGrupoTool } from "./tools/historico-grupo.js";
import { TelegramGroupWatcher } from "./input/group-watcher.js";
import { destilarGrupos } from "./knowledge/distiller.js";
import { ProviderFactory } from "./providers/provider-factory.js";
import { SkillLoader, SkillRouter } from "./skills/index.js";
import { AgentLoop } from "./core/agent-loop.js";
import { AgentController } from "./core/agent-controller.js";
import { TelegramInputHandler } from "./input/input-handler.js";

const SHUTDOWN_TIMEOUT_MS = 10000;

const WHICH = process.platform === "win32" ? "where" : "which";

function checkBinary(name: string): Promise<boolean> {
  // where/which so consultam o PATH; um caminho configurado precisa ser checado no disco
  if (name.includes("/") || name.includes("\\")) {
    return Promise.resolve(fs.existsSync(name));
  }
  return new Promise((resolve) => {
    execFile(WHICH, [name], { timeout: 5000 }, (err) => {
      resolve(err === null);
    });
  });
}

function checkEdgeTTS(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 5000 }, (err) => {
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
  // antes da rede: um provider sem chave so falha na primeira mensagem, e ate la
  // o bot parece saudavel. Barato de checar aqui, caro de descobrir no chat.
  const providerFactory = ProviderFactory.createFromConfig({
    primaryProvider: config.llm.primaryProvider,
    fallbackProviders: config.llm.fallbackProviders,
    apiKeys: config.llm.apiKeys,
    models: config.llm.models,
    openRouterApiKey: config.llm.openRouterApiKey,
    timeoutMs: config.agent.llmTimeoutMs,
    retryCount: config.agent.llmRetryCount,
    retryBaseDelayMs: config.agent.llmRetryBaseDelayMs,
  });

  const configured = [config.llm.primaryProvider, ...config.llm.fallbackProviders];
  const missing = configured.filter((name) => !providerFactory.getNames().includes(name));
  if (missing.length > 0) {
    console.error(
      `[Bootstrap] No usable LLM provider for: ${missing.join(", ")}.\n` +
      `Defina OPENROUTER_API_KEY, ou a chave propria de cada provedor (GEMINI_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY).`
    );
    process.exit(1);
  }
  console.info(`[Bootstrap] Providers registered: ${providerFactory.getNames().join(", ")}`);

  // ./data sai daqui: o MemoryManager ja cria o diretorio do dbPath configurado
  for (const dir of [config.filesystem.workspaceRoot, config.filesystem.tmpDir, config.filesystem.skillsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

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

  const edgeTTSAvailable = await checkEdgeTTS(config.audio.edgeTtsBinary);
  if (!edgeTTSAvailable) {
    console.warn("[Bootstrap] edge-tts not found — voice output disabled.");
  }

  const whisperAvailable = await checkBinary(config.audio.whisperBinary);
  if (!whisperAvailable) {
    console.warn("[Bootstrap] whisper not found — voice input disabled.");
  }

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
  // so existe se a leitura de grupos estiver configurada: sem o coletor a ferramenta
  // sempre responderia "nenhum grupo", gastando um turno do modelo para nada
  if (config.groups) {
    toolRegistry.register(new HistoricoGrupoTool(memoryManager));
  }
  console.info("[Bootstrap] Tools registered.");

  const skillLoader = new SkillLoader(config.filesystem.skillsDir, toolRegistry);
  const skills = skillLoader.loadAll();
  console.info(`[Bootstrap] Loaded ${skills.length} skills.`);

  const skillRouter = new SkillRouter(providerFactory);
  console.info("[Bootstrap] SkillRouter ready.");

  const agentLoop = new AgentLoop({
    maxIterations: config.agent.maxIterations,
    toolTimeoutMs: config.agent.toolTimeoutMs,
    logMessageContent: config.logging.logMessageContent,
  });
  console.info("[Bootstrap] AgentLoop ready.");

  const controller = new AgentController({
    memoryManager,
    agentLoop,
    skillRouter,
    skillLoader,
    toolRegistry,
    providerFactory,
    config,
  });
  console.info("[Bootstrap] AgentController ready.");

  const inputHandler = new TelegramInputHandler({
    bot,
    controller,
    config,
    voiceEnabled: ffmpegAvailable && whisperAvailable,
    // thunk: shutdown() e declarada abaixo e so precisa existir na hora da chamada
    onShutdown: () => shutdown(),
  });

  let groupWatcher: TelegramGroupWatcher | null = null;
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

      if (groupWatcher) {
        // nao pode abortar o shutdown: o MemoryManager ainda precisa gravar em disco abaixo
        await groupWatcher.stop().catch((err) => console.error(`[Bootstrap] Group watcher stop error: ${err}`));
        console.info("[Bootstrap] Group watcher stopped.");
      }

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

  if (config.groups) {
    // falha aqui nao derruba o bot: ler grupo e um extra, responder no Telegram e o essencial
    try {
      groupWatcher = new TelegramGroupWatcher(config.groups, memoryManager);
      await groupWatcher.start();

      // Sem await: a destilacao faz chamadas de LLM sobre centenas de mensagens e pode
      // levar minutos. O bot ja atende enquanto ela roda; o conhecimento aparece depois.
      void destilarGrupos({
        memory: memoryManager,
        // a lista crua, nao createWithFallback: o destilador precisa tratar resposta
        // vazia como falha e trocar de modelo, o que aquele involucro nao faz
        providers: providerFactory.getNames().map((n) => providerFactory.create(n)),
        workspaceRoot: config.filesystem.workspaceRoot,
      }).catch((err) => console.error(`[Bootstrap] Distiller failed: ${err}`));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Bootstrap] Group watcher failed to start: ${msg}`);
      groupWatcher = null;
    }
  }

  try {
    // start() so resolve quando o polling para, entao loga que esta pronto antes de aguardar
    console.info("[Bootstrap] GeneriClaw is running.");
    await inputHandler.start();
  } catch (err: unknown) {
    console.error(`[Bootstrap] Failed to start bot: ${err}`);
    await shutdown();
  }
}

// O cliente MTProto do coletor levanta erro fora de qualquer try/catch quando a sessao
// e revogada ou a conexao cai de vez. Sem isto o Node derruba o processo inteiro e o bot
// some do ar calado — quebrando a promessa de que falha no coletor nao afeta o resto.
process.on("unhandledRejection", (reason: unknown) => {
  const detalhe = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[Bootstrap] Unhandled rejection (processo continua):\n${detalhe}`);
  if (detalhe.includes("SESSION_REVOKED") || detalhe.includes("AUTH_KEY")) {
    // quase sempre e um segundo cliente usando a mesma TELEGRAM_SESSION, nao revogacao de fato
    console.error("[Bootstrap] Sessao do Telegram rejeitada. Verifique se nao ha outro processo usando a mesma TELEGRAM_SESSION; se nao houver, rode `npm run telegram:login`.");
  }
});

main().catch((err) => {
  console.error(`[Bootstrap] Fatal error: ${err}`);
  process.exit(1);
});