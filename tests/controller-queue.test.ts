import { describe, it, expect, afterEach, vi } from "vitest";
import type { Context } from "grammy";
import { AgentController } from "../src/core/agent-controller.js";
import type { AgentControllerDeps } from "../src/core/agent-controller.js";
import type { ProcessedInput } from "../src/input/types.js";
import type { AppConfig } from "../src/config.js";
import type { AgentLoopResult } from "../src/memory/memory-manager.js";

const MARCADOR = "MARCADOR-FILA-2E8B";

afterEach(() => vi.useRealTimers());

const resultado: AgentLoopResult = {
  conversationId: "",
  finalResponse: MARCADOR,
  toolCallsMade: 0,
  iterationsUsed: 1,
  finishReason: "stop",
  requiresAudioReply: false,
};

/** Destino de saida: o texto que chegaria na API do Telegram. */
class FakeContext {
  readonly replies: string[] = [];
  async reply(text: string): Promise<void> {
    this.replies.push(text);
  }
}

/** Destino persistente: o que saveResponse grava no metadata. */
const gravados: { delivered?: string }[] = [];

function controllerFake(): { controller: AgentController; ctx: FakeContext } {
  const memoryManager = {
    getConversation: () => ({ id: "c" }),
    createConversation: () => ({ id: "c" }),
    saveMessage: () => {},
    getRecentMessages: () => [{ role: "user", content: "oi" }],
    saveResponse: (_id: string, _r: unknown, delivered?: string) => void gravados.push({ delivered }),
    shutdown: async () => {},
  };

  const deps = {
    memoryManager,
    agentLoop: { getBaseSystemPrompt: () => "s", run: async () => ({ ...resultado }) },
    skillRouter: { route: async () => null },
    skillLoader: { reload: () => [] },
    toolRegistry: {},
    providerFactory: { createWithFallback: () => ({ name: "f", generate: async () => ({}) }) },
    config: {
      audio: { ttsVoiceId: "v", edgeTtsBinary: "edge-tts", ffmpegBinary: "ffmpeg" },
      filesystem: { tmpDir: "./tmp" },
      llm: { primaryProvider: "p", fallbackProviders: [] },
    } as unknown as AppConfig,
  } as unknown as AgentControllerDeps;

  return { controller: new AgentController(deps), ctx: new FakeContext() };
}

const entrada = (): ProcessedInput => ({
  conversationId: "c",
  userId: "u",
  content: "oi",
  source: "text",
  requiresAudioReply: false,
});

describe("fila de mensagens por conversa", () => {
  it("nao deixa timers pendurados depois de processar tudo", async () => {
    vi.useFakeTimers();
    const { controller, ctx } = controllerFake();

    // duas na mesma conversa: a segunda enfileira atras da primeira e arma o
    // timer de deteccao de travamento
    void controller.handle(entrada(), ctx as unknown as Context);
    void controller.handle(entrada(), ctx as unknown as Context);

    // drena as microtasks sem mexer no relogio: shutdown() nao serve para esperar,
    // porque ele liga isShuttingDown e o pipeline descarta a resposta em voo
    for (let i = 0; i < 50; i++) await Promise.resolve();

    // controle: as duas chegaram ao destino, entao o caminho rodou de verdade
    expect(ctx.replies).toEqual([MARCADOR, MARCADOR]);
    // o timer de 5 minutos segurava o event loop depois do trabalho terminar
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("registro do que foi entregue", () => {
  it("grava no metadata a estrategia que realmente respondeu", async () => {
    gravados.length = 0;
    const { controller, ctx } = controllerFake();

    void controller.handle(entrada(), ctx as unknown as Context);
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(ctx.replies).toEqual([MARCADOR]); // controle: a resposta saiu mesmo
    expect(gravados.map((g) => g.delivered)).toEqual(["text"]);
  });
});
