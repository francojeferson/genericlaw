import { describe, it, expect } from "vitest";
import type { Context } from "grammy";
import { TelegramOutputHandler } from "../src/output/output-handler.js";
import type { AgentLoopResult } from "../src/memory/memory-manager.js";

// A e a mensagem escrita para o usuario; B e o detalhe cru da API, que serve ao log
// e nao ao chat. B tambem e o controle: ele prova que a captura le o destino certo.
const MARCADOR_A = "MARCADOR-AMIGAVEL-9D1E";
const MARCADOR_B = "MARCADOR-TECNICO-3A7C";

/** Destino: o texto que chegaria na API do Telegram. */
class FakeContext {
  readonly replies: string[] = [];
  async reply(text: string): Promise<void> {
    if (text.length === 0) throw new Error("400: message text is empty");
    this.replies.push(text);
  }
}

function handlerFor(ctx: FakeContext): TelegramOutputHandler {
  return new TelegramOutputHandler(ctx as unknown as Context, { ttsVoiceId: "v", tmpDir: "./tmp" });
}

const erro = (over: Partial<AgentLoopResult> = {}): AgentLoopResult => ({
  conversationId: "1",
  finalResponse: `Desculpe, ${MARCADOR_A}`,
  toolCallsMade: 0,
  iterationsUsed: 1,
  finishReason: "error",
  requiresAudioReply: false,
  errorMessage: `provider 429 ${MARCADOR_B}`,
  ...over,
});

describe("resposta de erro entregue ao usuario", () => {
  it("entrega a mensagem escrita para o usuario, nao o erro cru da API", async () => {
    const ctx = new FakeContext();
    await handlerFor(ctx).send(erro());

    const entregue = ctx.replies.join("\n");
    expect(entregue).toContain(MARCADOR_A);
    expect(entregue).not.toContain(MARCADOR_B);
  });

  it("cai no detalhe tecnico quando nao ha mensagem escrita (controle da busca)", async () => {
    const ctx = new FakeContext();
    await handlerFor(ctx).send(erro({ finalResponse: "   " }));

    // sem texto amigavel, algo precisa chegar: o Telegram recusa mensagem vazia
    expect(ctx.replies.join("\n")).toContain(MARCADOR_B);
  });
});
