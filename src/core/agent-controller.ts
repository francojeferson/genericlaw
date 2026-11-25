import type { ProcessedInput } from "../input/types.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { AgentLoop } from "./agent-loop.js";
import { SkillRouter, SkillLoader } from "../skills/index.js";
import type { SkillManifest } from "../skills/index.js";
import { TelegramOutputHandler } from "../output/output-handler.js";
import type { Delivered } from "../output/output-handler.js";
import { ProviderFactory } from "../providers/provider-factory.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ILlmProvider, LlmMessage } from "../providers/types.js";
import type { Context } from "grammy";
import type { AppConfig } from "../config.js";

const MAX_PENDING_PER_CONVERSATION = 5;
const STALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface AgentControllerDeps {
  memoryManager: MemoryManager;
  agentLoop: AgentLoop;
  skillRouter: SkillRouter;
  skillLoader: SkillLoader;
  toolRegistry: ToolRegistry;
  providerFactory: ProviderFactory;
  config: AppConfig;
}

export class AgentController {
  private memoryManager: MemoryManager;
  private agentLoop: AgentLoop;
  private skillRouter: SkillRouter;
  private skillLoader: SkillLoader;
  private toolRegistry: ToolRegistry;
  private providerFactory: ProviderFactory;
  private isShuttingDown = false;
  private config: AppConfig;

  private processingQueue: Map<string, Promise<void>> = new Map();
  private pendingCount: Map<string, number> = new Map();

  constructor(deps: AgentControllerDeps) {
    this.memoryManager = deps.memoryManager;
    this.agentLoop = deps.agentLoop;
    this.skillRouter = deps.skillRouter;
    this.skillLoader = deps.skillLoader;
    this.toolRegistry = deps.toolRegistry;
    this.providerFactory = deps.providerFactory;
    this.config = deps.config;
  }

  async handle(input: ProcessedInput, ctx: Context): Promise<void> {
    if (this.isShuttingDown) {
      console.warn("[AgentController] System shutting down, rejecting message.");
      return;
    }

    const { conversationId } = input;

    const currentCount = this.pendingCount.get(conversationId) || 0;
    if (currentCount >= MAX_PENDING_PER_CONVERSATION) {
      console.warn(`[AgentController] Queue full for conversation ${conversationId}; rejecting this message.`);
      await ctx.reply("⚠️ Ainda estou processando suas mensagens anteriores. Aguarde um momento e tente de novo.")
        .catch(() => { /* user may have blocked the bot */ });
      return;
    }

    const existingPromise = this.processingQueue.get(conversationId);

    this.pendingCount.set(conversationId, currentCount + 1);

    const selfCheck = { current: undefined as Promise<void> | undefined };
    const promise = (async () => {
      if (existingPromise) {
        // sem o clearTimeout, cada mensagem enfileirada segurava o event loop por
        // 5 minutos depois de o trabalho ja ter terminado
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<void>((_, reject) => {
            stallTimer = setTimeout(() => reject(new Error("STALL")), STALL_TIMEOUT_MS);
          });
          await Promise.race([existingPromise, timeout]);
        } catch {
          console.warn(`[AgentController] Previous message stall detected for conversation ${conversationId}.`);
        } finally {
          clearTimeout(stallTimer);
        }
      }

      try {
        await this.process(input, ctx);
      } finally {
        this.pendingCount.set(conversationId, (this.pendingCount.get(conversationId) || 1) - 1);
        if (this.processingQueue.get(conversationId) === selfCheck.current) {
          this.processingQueue.delete(conversationId);
        }
      }
    })();

    selfCheck.current = promise;
    this.processingQueue.set(conversationId, promise);
  }

  private async process(input: ProcessedInput, ctx: Context): Promise<void> {
    const { conversationId, userId, content, requiresAudioReply, source } = input;
    console.info(
      `[AgentController] input (${source}${requiresAudioReply ? ", audio reply" : ""}) -> processing conversation ${conversationId}`
    );

    const outputHandler = new TelegramOutputHandler(
      ctx,
      {
        ttsVoiceId: this.config.audio.ttsVoiceId,
        tmpDir: this.config.filesystem.tmpDir,
        edgeTtsBinary: this.config.audio.edgeTtsBinary,
        ffmpegBinary: this.config.audio.ffmpegBinary,
      }
    );

    try {
      let conversation = this.memoryManager.getConversation(conversationId);
      if (!conversation) {
        conversation = this.memoryManager.createConversation(userId, conversationId);
      }

      const availableSkills = this.skillLoader.reload();
      let skillName: string | null = null;

      try {
        skillName = await this.skillRouter.route(content, availableSkills);
      } catch {
        skillName = null;
      }

      console.info(`[AgentController] ${skillName ? `skill: ${skillName}` : "no skill"}`);

      this.memoryManager.saveMessage(conversationId, "user", content);

      const recentMessages = this.memoryManager.getRecentMessages(conversationId);

      let llmProvider: ILlmProvider;
      try {
        const allProviders = [this.config.llm.primaryProvider, ...this.config.llm.fallbackProviders];
        llmProvider = this.providerFactory.createWithFallback(allProviders);
      } catch {
        console.error("[AgentController] No providers available.");
        await outputHandler.sendError("Nenhum provedor de IA disponível.");
        return;
      }

      const systemPrompt = this.agentLoop.getBaseSystemPrompt();

      // tools vao ao provider como function declarations nativas, nao como texto de prompt
      const messages: LlmMessage[] = [
        { role: "system", content: systemPrompt },
      ];

      if (skillName) {
        const skillManifest = availableSkills.find((s) => s.name === skillName);
        if (skillManifest) {
          messages.push({ role: "system", content: skillManifest.systemPrompt });
        }
      }

      // recentMessages ja termina com o turno do usuario salvo acima - nao empurrar de novo
      for (const msg of recentMessages) {
        messages.push({ role: msg.role, content: msg.content });
      }

      console.info(`[AgentController] agent -> processing with ${messages.length} messages`);

      const result = await this.agentLoop.run(messages, llmProvider, this.toolRegistry);
      result.conversationId = conversationId;
      result.requiresAudioReply = requiresAudioReply;

      // o metadata registra o que saiu, nao o que foi pedido: um pedido de audio
      // que cai para texto ficaria indistinguivel de um audio entregue.
      // O finally garante que a resposta e salva mesmo se o envio falhar.
      let delivered: Delivered = "none";
      try {
        if (!this.isShuttingDown) {
          delivered = await outputHandler.send(result);
        }
      } finally {
        this.memoryManager.saveResponse(conversationId, result, delivered);
        console.info(`[AgentController] delivered: ${delivered}`);
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AgentController] Pipeline error: ${msg}`);
      // Nunca falhar em silencio: uma excecao nao reportada aqui e indistinguivel do bot
      // ignorando o usuario, o que esconde bugs de pipeline indefinidamente.
      await outputHandler
        .sendError("Não consegui processar sua mensagem. Tente novamente em instantes.")
        .catch(() => { /* user may have blocked the bot */ });
    }
  }

  resetConversation(conversationId: string): number {
    return this.memoryManager.clearMessages(conversationId);
  }

  async shutdown(): Promise<void> {
    console.info("[AgentController] Shutting down...");
    this.isShuttingDown = true;

    const pending = Array.from(this.processingQueue.values());
    if (pending.length > 0) {
      console.info(`[AgentController] Waiting for ${pending.length} in-flight messages...`);
      await Promise.allSettled(pending);
    }

    await this.memoryManager.shutdown();
    console.info("[AgentController] Shutdown complete.");
  }
}