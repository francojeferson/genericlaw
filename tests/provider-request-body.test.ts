import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import { AgentLoop } from "../src/core/agent-loop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CriarArquivoTool } from "../src/tools/criar-arquivo.js";
import { OpenAiCompatProvider, DIRECT_PRESETS, openRouterProvider } from "../src/providers/openai-compat-provider.js";
import { GeminiProvider } from "../src/providers/gemini-provider.js";
import type { ILlmProvider } from "../src/providers/types.js";

const WS = "./tmp/test-body";
afterAll(() => fs.rmSync(WS, { recursive: true, force: true }));

// Marcadores plantados: A viaja como id da tool call, B viaja no texto do usuario.
// B existe para provar que a busca le o objeto certo - sem ele, "A nao apareceu"
// poderia significar apenas que a busca esta quebrada.
const MARCADOR_A = "MARCADOR-TOOLCALL-7F3A";
const MARCADOR_B = "MARCADOR-CONTROLE-B2E9";

interface SentMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

/** Corpos capturados no destino: o que cada provider realmente colocou no fetch. */
let sentBodies: { messages: SentMessage[] }[] = [];

beforeEach(() => {
  sentBodies = [];
  let call = 0;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    sentBodies.push(JSON.parse(init.body));
    call++;
    // 1a chamada: o modelo pede a ferramenta. 2a: responde em texto.
    const payload =
      call === 1
        ? {
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: MARCADOR_A,
                      type: "function",
                      function: { name: "criar_arquivo", arguments: JSON.stringify({ path: "m.md", content: "x" }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }
        : { choices: [{ message: { content: "pronto" }, finish_reason: "stop" }] };
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  });
});

afterEach(() => vi.unstubAllGlobals());

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(new CriarArquivoTool(WS));
  return r;
}

/** Roda o caminho real: AgentLoop -> provider -> fetch. Nada chamado a mao. */
async function runRealPath(provider: ILlmProvider): Promise<void> {
  await new AgentLoop({ maxIterations: 5, toolTimeoutMs: 5000 }).run(
    [
      { role: "system", content: "s" },
      { role: "user", content: `crie o arquivo ${MARCADOR_B}` },
    ],
    provider,
    registry()
  );
}

const providers: [string, () => ILlmProvider][] = [
  ["deepseek", () => new OpenAiCompatProvider({ name: "deepseek", apiKey: "k", retryCount: 0, ...DIRECT_PRESETS.deepseek })],
  ["groq", () => new OpenAiCompatProvider({ name: "groq", apiKey: "k", retryCount: 0, ...DIRECT_PRESETS.groq })],
  ["openrouter", () => openRouterProvider({ name: "openrouter", apiKey: "k", retryCount: 0 })],
];

describe.each(providers)("corpo enviado por %s", (_name, make) => {
  it("o marcador de controle chega ao destino (prova que a busca olha no lugar certo)", async () => {
    await runRealPath(make());

    expect(sentBodies.length).toBe(2);
    const chegou = sentBodies[1].messages.some((m) => (m.content ?? "").includes(MARCADOR_B));
    expect(chegou).toBe(true);
  });

  it("toda mensagem role=tool tem um assistant anterior declarando aquele tool_call id", async () => {
    await runRealPath(make());

    const messages = sentBodies[1].messages;
    const declarados = new Set(
      messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((tc) => tc.id) : []))
    );
    const resultados = messages.filter((m) => m.role === "tool");

    // a regra da propria API OpenAI: um resultado orfao e rejeitado com 400
    expect(resultados.length).toBeGreaterThan(0);
    for (const r of resultados) {
      expect(declarados.has(r.tool_call_id!)).toBe(true);
    }
    expect(declarados.has(MARCADOR_A)).toBe(true);
  });

  it("a tool call declarada carrega nome e argumentos em JSON", async () => {
    await runRealPath(make());

    const assistant = sentBodies[1].messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
    const tc = assistant!.tool_calls![0];
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("criar_arquivo");
    expect(JSON.parse(tc.function.arguments)).toEqual({ path: "m.md", content: "x" });
  });
});

// Irma montada de outro jeito: o Gemini usa `contents`, nao `messages`.
describe("corpo enviado por gemini", () => {
  it("o resultado da ferramenta chega ao destino", async () => {
    const bodies: { contents: { role: string; parts: { text?: string }[] }[] }[] = [];
    let call = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      call++;
      const payload =
        call === 1
          ? {
              candidates: [
                {
                  content: {
                    parts: [{ functionCall: { name: "criar_arquivo", args: { path: "g.md", content: MARCADOR_A } } }],
                  },
                  finishReason: "STOP",
                },
              ],
            }
          : { candidates: [{ content: { parts: [{ text: "pronto" }] }, finishReason: "STOP" }] };
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    });

    await runRealPath(new GeminiProvider({ apiKey: "k", retryCount: 0 }));

    const textos = bodies[1].contents.flatMap((c) => c.parts.map((p) => p.text ?? ""));
    expect(textos.some((t) => t.includes(MARCADOR_B))).toBe(true); // controle
    expect(textos.some((t) => t.startsWith("Tool result:"))).toBe(true);
  });
});

// `retryCount || 3` transformava o 0 permitido (LLM_RETRY_COUNT=0, "nao tentar de novo") em 3.
describe("retryCount do gemini", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [0, 1],
    [2, 3], // controle: com tentativas liberadas o 503 e repetido, entao a contagem le o destino certo
  ])("retryCount %i faz %i chamada(s) quando o servico responde 503", async (retryCount, esperado) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let chamadas = 0;
    vi.stubGlobal("fetch", async () => {
      chamadas++;
      return { ok: false, status: 503, statusText: "Service Unavailable" } as unknown as Response;
    });

    const gemini = new GeminiProvider({ apiKey: "k", retryCount, retryBaseDelayMs: 1 });
    await expect(gemini.generate([{ role: "user", content: "oi" }])).rejects.toThrow("503");

    expect(chamadas).toBe(esperado);
  });
});
