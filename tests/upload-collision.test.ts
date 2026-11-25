import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { Bot, Context } from "grammy";
import { TelegramInputHandler } from "../src/input/input-handler.js";
import type { AgentController } from "../src/core/agent-controller.js";
import type { AppConfig } from "../src/config.js";
import type { ProcessedInput } from "../src/input/types.js";

const WS = "./tmp/test-upload-ws";
const TMP = "./tmp/test-upload-tmp";
const UPLOADS = path.join(WS, "uploads");

// Dois envios com o mesmo nome de arquivo. B e o controle: o ultimo sempre chega,
// entao se B nao aparecer no disco e a busca que esta quebrada, nao a peca.
const MARCADOR_A = "MARCADOR-UPLOAD-1-D4E7";
const MARCADOR_B = "MARCADOR-UPLOAD-2-F9A1";

afterAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});

const config = {
  telegram: { allowedUserIds: ["7"] },
  filesystem: { workspaceRoot: WS, tmpDir: TMP },
  audio: { whisperModel: "small", whisperBinary: "whisper", whisperLanguage: "pt", ffmpegBinary: "ffmpeg" },
} as unknown as AppConfig;

type Handler = (ctx: Context) => Promise<void>;
type Gate = (ctx: Context, next: () => Promise<void>) => Promise<void>;

/** Bot fake que guarda o que o start() registra, como o grammy faria. */
function fakeBot() {
  const handlers = new Map<string, Handler>(); // por evento, ou "/comando"
  const registrado: string[] = []; // ordem das chamadas: o gate tem que vir antes de todo handler
  const reg: { gate?: Gate; aoFalhar?: (e: { error: unknown }) => void } = {};
  return {
    token: "t",
    api: { getFile: async () => ({ file_path: "remote/doc.md" }) },
    use: (fn: Gate) => {
      registrado.push("use");
      reg.gate = fn;
    },
    catch: (fn: (e: { error: unknown }) => void) => {
      registrado.push("catch");
      reg.aoFalhar = fn;
    },
    command: (nomes: string | string[], fn: Handler) => {
      registrado.push("command");
      for (const n of Array.isArray(nomes) ? nomes : [nomes]) handlers.set(`/${n}`, fn);
    },
    on: (ev: string | string[], fn: Handler) => {
      registrado.push("on");
      for (const e of Array.isArray(ev) ? ev : [ev]) handlers.set(e, fn);
    },
    start: async () => void registrado.push("start"),
    stop: async () => {},
    handlers,
    registrado,
    reg,
  };
}

const entregues: ProcessedInput[] = [];
let reinicios = 0;
const controller = {
  handle: async (input: ProcessedInput) => void entregues.push(input),
  resetConversation: () => (reinicios++, 0),
} as unknown as AgentController;

function ctxComDocumento(): Context {
  return {
    from: { id: 7 },
    chat: { id: 7 },
    message: { document: { file_id: "f1", file_name: "contrato.md", mime_type: "text/markdown" } },
    reply: async () => {},
    replyWithChatAction: async () => {},
  } as unknown as Context;
}

beforeEach(() => {
  entregues.length = 0;
  reinicios = 0;
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Caminho real: o start() registra tudo no bot fake, como faria no grammy. */
async function iniciar(voiceEnabled = false) {
  const bot = fakeBot();
  await new TelegramInputHandler({ bot: bot as unknown as Bot, controller, config, voiceEnabled }).start();
  return bot;
}

async function handlerDeDocumento(): Promise<Handler> {
  return (await iniciar()).handlers.get("message:document")!;
}

/** Caminho real: start() registra o handler, o handler baixa, salva e entrega. */
async function enviarDocumento(conteudo: string): Promise<void> {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(conteudo).buffer,
  }));

  await (await handlerDeDocumento())(ctxComDocumento());
}

describe("dois uploads com o mesmo nome", () => {
  it("os dois conteudos sobrevivem no disco", async () => {
    await enviarDocumento(MARCADOR_A);
    await enviarDocumento(MARCADOR_B);

    const noDisco = fs
      .readdirSync(UPLOADS)
      .map((f) => fs.readFileSync(path.join(UPLOADS, f), "utf-8"))
      .join("\n");

    expect(noDisco).toContain(MARCADOR_B); // controle
    expect(noDisco).toContain(MARCADOR_A);
  });

  it("dois downloads no mesmo milissegundo nao se sobrescrevem no tmp", async () => {
    // o nome do temporario vinha de Date.now(): congelar o relogio faz a corrida
    // acontecer sempre, em vez de uma vez a cada mil envios
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const conteudos = [MARCADOR_A, MARCADOR_B];
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      const corpo = conteudos[n++] ?? MARCADOR_B;
      await Promise.resolve(); // cede o controle entre baixar e ler, como a rede faria
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(corpo).buffer };
    });

    const disparar = await handlerDeDocumento();
    await Promise.all([disparar(ctxComDocumento()), disparar(ctxComDocumento())]);

    const entregue = entregues.map((e) => e.content).join("\n");
    expect(entregue).toContain(MARCADOR_B); // controle
    expect(entregue).toContain(MARCADOR_A);
  });

  it("o ponteiro entregue ao modelo aponta para o arquivo recem-salvo", async () => {
    await enviarDocumento(MARCADOR_A);
    await enviarDocumento(MARCADOR_B);

    const [rel] = entregues[1].content.match(/uploads\/[^"]+/) ?? [];
    expect(rel).toBeTruthy();
    expect(fs.readFileSync(path.join(WS, rel!), "utf-8")).toContain(MARCADOR_B);
  });
});

/** Update falso de um chat; `over` troca remetente, chat, mensagem ou os espioes de saida. */
const updateDe = (over: Record<string, unknown> = {}) =>
  ({
    from: { id: 7 },
    chat: { id: 7, type: "private" },
    message: {},
    reply: vi.fn(async () => {}),
    replyWithChatAction: vi.fn(async () => {}),
    ...over,
  }) as unknown as Context;

// Sem handler de erro o grammy relanca a excecao do primeiro handler que falhar e para o
// polling; o main.ts trata isso como falha de boot e encerra o processo.
describe("uma falha de handler nao derruba o bot", () => {
  it("start() registra o catch antes do polling, e ele so loga o erro", async () => {
    const bot = await iniciar();
    expect(bot.registrado).toContain("catch");
    expect(bot.registrado.indexOf("catch")).toBeLessThan(bot.registrado.indexOf("start"));

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const causa = new Error("429 Too Many Requests");
    expect(() => bot.reg.aoFalhar!({ error: causa })).not.toThrow();
    expect(log).toHaveBeenCalledWith("[Telegram] handler failed:", causa);
  });

  // O "digitando" e so um aviso visual: uma falha nele nao pode cancelar a mensagem.
  const digitandoFalha = async () => {
    throw new Error("429 Too Many Requests");
  };

  it("texto: a mensagem chega ao controller mesmo com o digitando falhando", async () => {
    const bot = await iniciar();
    await bot.handlers.get("message:text")!(
      updateDe({ message: { text: "oi" }, replyWithChatAction: digitandoFalha })
    );
    expect(entregues.map((e) => e.content)).toEqual(["oi"]);
  });

  it("documento: o upload e entregue mesmo com o digitando falhando", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(MARCADOR_A).buffer,
    }));
    await (await handlerDeDocumento())(
      updateDe({
        message: { document: { file_id: "f1", file_name: "contrato.md", mime_type: "text/markdown" } },
        replyWithChatAction: digitandoFalha,
      })
    );
    expect(entregues).toHaveLength(1);
  });

  it("voz: segue ate a etapa de download em vez de abortar no digitando", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reply = vi.fn(async () => {});

    await (await iniciar(true)).handlers.get("message:voice")!(
      updateDe({ message: { voice: { file_id: "v1" } }, reply, replyWithChatAction: digitandoFalha })
    );

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("etapa 'download'"));
  });
});

// A lista de permitidos valia em cinco copias coladas, uma por handler, e nenhuma coberta.
// Agora e um unico gate registrado antes de tudo, e este teste passa o update por ele e
// depois por cada handler, como a cadeia do grammy faz.
describe("so o dono, em chat privado, alcanca os handlers", () => {
  // texto, voz e documento juntos: alcancado, cada handler faz algo visivel
  const message = { text: "oi", voice: { file_id: "v" }, document: { file_id: "d", file_name: "x.txt" } };

  /** Quantas respostas, entregas ao controller e reinicios cada handler produziu. */
  async function efeitosPorHandler(over: Record<string, unknown>): Promise<Record<string, number>> {
    const bot = await iniciar();
    const { registrado } = bot;
    // nenhum handler (comando ou evento) e registrado antes do gate
    expect(registrado).toContain("use");
    expect(registrado.indexOf("use")).toBeLessThan(Math.min(registrado.indexOf("command"), registrado.indexOf("on")));

    const efeitos: Record<string, number> = {};
    for (const [nome, handler] of bot.handlers) {
      const antes = entregues.length + reinicios;
      const reply = vi.fn(async () => {});
      const ctx = updateDe({ message, reply, ...over });
      await bot.reg.gate!(ctx, () => handler(ctx));
      efeitos[nome] = entregues.length + reinicios - antes + reply.mock.calls.length;
    }
    return efeitos;
  }

  it("controle: o dono em chat privado alcanca todos os handlers", async () => {
    const efeitos = await efeitosPorHandler({});

    // sem isto, "nada aconteceu" abaixo poderia ser so um bot fake que nao registrou nada
    expect(Object.keys(efeitos)).toEqual(
      expect.arrayContaining(["/novo", "/reset", "/parar", "/stop", "message:text", "message:voice", "message:audio", "message:document"])
    );
    for (const [nome, n] of Object.entries(efeitos)) expect(n, nome).toBeGreaterThan(0);
  });

  const barrados: [string, Record<string, unknown>][] = [
    ["id fora da lista", { from: { id: 8 }, chat: { id: 8, type: "private" } }],
    ["grupo, mesmo com id da lista", { chat: { id: -100, type: "supergroup" } }],
    ["update sem remetente", { from: undefined }],
  ];

  it.each(barrados)("ignora calado: %s", async (_nome, over) => {
    const efeitos = await efeitosPorHandler(over);

    // nem controller.handle, nem resetConversation, nem uma resposta
    for (const [nome, n] of Object.entries(efeitos)) expect(n, nome).toBe(0);
  });
});
