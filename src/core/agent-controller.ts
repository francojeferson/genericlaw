import type { ProcessedInput } from "../input/types.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { AgentLoop } from "./agent-loop.js";
import { SkillRouter, SkillLoader } from "../skills/index.js";
import type { SkillManifest } from "../skills/index.js";
import { TelegramOutputHandler } from "../output/output-handler.js";
import { ProviderFactory } from "../providers/provider-factory.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ILlmProvider, LlmMessage } from "../providers/types.js";
import { EventEmitter } from "events";
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
  eventEmitter: EventEmitter;
  config: AppConfig;
}

export interface AgentControllerHandle {
  input: ProcessedInput;
  ctx: Context;
}

export class AgentController {
  private memoryManager: MemoryManager;
  private agentLoop: AgentLoop;
  private skillRouter: SkillRouter;
  private skillLoader: SkillLoader;
  private toolRegistry: ToolRegistry;
  private providerFactory: ProviderFactory;
  private isShuttingDown = false;
  private eventEmitter: EventEmitter;
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
    this.eventEmitter = deps.eventEmitter;
    this.config = deps.config;

    this.eventEmitter.on("userBlocked", ({ conversationId }: { conversationId: string }) => {
      this.memoryManager.markConversationBlocked(conversationId);
    });
  }

  async handle(input: ProcessedInput, ctx: Context): Promise<void> {
    if (this.isShuttingDown) {
      console.warn("[AgentController] System shutting down, rejecting message.");
      return;
    }

    const { conversationId } = input;

    const currentCount = this.pendingCount.get(conversationId) || 0;
    if (currentCount >= MAX_PENDING_PER_CONVERSATION) {
      console.warn(`[AgentController] Message queue full for conversation ${conversationId}. Dropping oldest pending.`);
      return;
    }

    const existingPromise = this.processingQueue.get(conversationId);

    this.pendingCount.set(conversationId, currentCount + 1);

    const selfCheck = { current: undefined as Promise<void> | undefined };
    const promise = (async () => {
      if (existingPromise) {
        try {
          const timeout = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("STALL")), STALL_TIMEOUT_MS)
          );
          await Promise.race([existingPromise, timeout]);
        } catch {
          console.warn(`[AgentController] Previous message stall detected for conversation ${conversationId}.`);
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
    const { conversationId, userId, content, requiresAudioReply } = input;
    console.info(`[AgentController] input -> processing conversation ${conversationId}`);

    const outputHandler = new TelegramOutputHandler(
      ctx,
      {
        ttsVoiceId: this.config.audio.ttsVoiceId,
        tmpDir: this.config.filesystem.tmpDir,
      },
      this.eventEmitter
    );

    try {
      if (this.memoryManager.isConversationBlocked(conversationId)) {
        console.info(`[AgentController] Skipping message from blocked user ${userId}.`);
        return;
      }

      let conversation = this.memoryManager.getConversation(conversationId);
      if (!conversation) {
        conversation = this.memoryManager.createConversation(userId);
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
      const toolDefs = this.toolRegistry.getToolDefinitions();

      const messages: LlmMessage[] = [
        { role: "system", content: systemPrompt },
      ];

      if (toolDefs.length > 0) {
        messages.push({
          role: "system",
          content: `You have access to the following tools. Use them when needed:\n${JSON.stringify(toolDefs, null, 2)}`,
        });
      }

      if (skillName) {
        const skillManifest = availableSkills.find((s) => s.name === skillName);
        if (skillManifest) {
          messages.push({ role: "system", content: skillManifest.systemPrompt });
        }
      }

      for (const msg of recentMessages) {
        messages.push({ role: msg.role, content: msg.content });
      }

      messages.push({ role: "user", content });

      console.info(`[AgentController] agent -> processing with ${messages.length} messages`);

      const result = await this.agentLoop.run(messages, llmProvider, this.toolRegistry);
      result.conversationId = conversationId;
      result.requiresAudioReply = requiresAudioReply;

      this.memoryManager.saveResponse(conversationId, result);

      console.info(`[AgentController] memory -> output`);

      if (this.isShuttingDown) return;

      await outputHandler.send(conversationId, result);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[AgentController] Pipeline error: ${msg}`);
    }
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