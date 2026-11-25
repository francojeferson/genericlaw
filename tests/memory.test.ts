import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import { randomBytes } from "crypto";
import { MemoryManager } from "../src/memory/memory-manager.js";

const DIR = "./tmp/test-mem";
const DB = `${DIR}/db.sqlite`;
const CHAT_ID = "420273599";

let mm: MemoryManager;

beforeEach(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  mm = new MemoryManager({ dbPath: DB, windowSize: 5, dbMaxSizeMb: 500 });
  await mm.initialize();
});

// O MemoryManager guarda o Database num campo estatico; shutdown() limpa ele,
// entao sem isto cada teste reusaria o banco em memoria do teste anterior.
afterEach(async () => {
  vi.restoreAllMocks(); // antes do shutdown: ele grava em disco e nao pode pegar um fs falso
  await mm.shutdown();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("createConversation", () => {
  it("uses the supplied id so messages can reference it by foreign key", () => {
    const conv = mm.createConversation("user-1", CHAT_ID);
    expect(conv.id).toBe(CHAT_ID);
    // antes da correcao isto lancava: FOREIGN KEY constraint failed
    expect(() => mm.saveMessage(CHAT_ID, "user", "oi")).not.toThrow();
  });

  it("falls back to a generated id when none is given", () => {
    const conv = mm.createConversation("user-1");
    expect(conv.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(conv.id).not.toBe(CHAT_ID);
  });

  it("round-trips through getConversation", () => {
    mm.createConversation("user-1", CHAT_ID);
    expect(mm.getConversation(CHAT_ID)?.userId).toBe("user-1");
    expect(mm.getConversation("nope")).toBeNull();
  });
});

// Teste de contrato, nao de regressao: ORDER BY created_at tambem passa aqui,
// porque o SQLite desempata por rowid atraves do indice da conversa. Ordenar por
// id torna essa garantia explicita em vez de acidental.
describe("message ordering", () => {
  it("preserves insertion order when timestamps collide in the same millisecond", () => {
    mm.createConversation("user-1", CHAT_ID);

    // escritas num laco apertado, entao muitas compartilham o mesmo created_at no milissegundo
    const written: string[] = [];
    for (let i = 0; i < 20; i++) {
      const content = `msg-${i}`;
      mm.saveMessage(CHAT_ID, i % 2 === 0 ? "user" : "assistant", content);
      written.push(content);
    }

    const recent = mm.getRecentMessages(CHAT_ID);
    expect(recent.length).toBe(5); // windowSize

    // precisam ser as ULTIMAS 5 escritas, na ordem em que foram escritas
    expect(recent.map((m) => m.content)).toEqual(written.slice(-5));
  });

  it("keeps the newest messages when truncating", () => {
    mm.createConversation("user-1", CHAT_ID);
    for (let i = 0; i < 12; i++) mm.saveMessage(CHAT_ID, "user", `m${i}`);

    mm.truncateOldMessages(CHAT_ID);
    const left = mm.getRecentMessages(CHAT_ID).map((m) => m.content);
    expect(left).toEqual(["m7", "m8", "m9", "m10", "m11"]);
  });
});

describe("clearMessages", () => {
  it("wipes history but keeps the conversation row", () => {
    mm.createConversation("user-1", CHAT_ID);
    for (let i = 0; i < 4; i++) mm.saveMessage(CHAT_ID, "user", `m${i}`);

    expect(mm.clearMessages(CHAT_ID)).toBe(4);
    expect(mm.getRecentMessages(CHAT_ID)).toEqual([]);
    // a linha precisa sobreviver, senao a proxima mensagem falha na checagem de foreign key
    expect(mm.getConversation(CHAT_ID)).not.toBeNull();
    expect(() => mm.saveMessage(CHAT_ID, "user", "depois")).not.toThrow();
  });

  it("is a no-op on an unknown conversation", () => {
    expect(mm.clearMessages("nao-existe")).toBe(0);
  });
});

describe("schema migration", () => {
  it("persists schema changes to disk even with no message writes", async () => {
    // a guarda de flag suja pula escritas se nenhuma linha mudou, o que de outra
    // forma aplicaria a migracao em memoria e a perderia no reinicio
    await mm.shutdown();
    expect(fs.existsSync(DB)).toBe(true);

    const Sql = (await import("sql.js")).default;
    const SQL = await Sql();
    const db = new SQL.Database(fs.readFileSync(DB));
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'");
    const names: string[] = [];
    while (stmt.step()) names.push(String(stmt.getAsObject().name));
    stmt.free();
    db.close();

    expect(names).toContain("idx_messages_conv_id");
    expect(names).not.toContain("idx_messages_role");

    mm = new MemoryManager({ dbPath: DB, windowSize: 5, dbMaxSizeMb: 500 });
    await mm.initialize(); // let afterEach shut it down
  });
});

describe("persistence", () => {
  it("writes the database on shutdown", async () => {
    mm.createConversation("user-1", CHAT_ID);
    mm.saveMessage(CHAT_ID, "user", "persist me");

    // saveToDisk() aborta com a flag isShutdown, entao o shutdown precisa salvar antes de liga-la
    await mm.shutdown();
    expect(fs.existsSync(DB)).toBe(true);

    const reopened = new MemoryManager({ dbPath: DB, windowSize: 5, dbMaxSizeMb: 500 });
    await reopened.initialize();
    expect(reopened.getRecentMessages(CHAT_ID).map((m) => m.content)).toEqual(["persist me"]);

    mm = reopened; // let afterEach shut this one down
  });

  it("so troca o arquivo por rename: falha antes dele deixa o banco anterior intacto", async () => {
    mm.createConversation("user-1", CHAT_ID);
    await mm.shutdown();
    const v1 = fs.readFileSync(DB);

    mm = new MemoryManager({ dbPath: DB, windowSize: 5, dbMaxSizeMb: 500 });
    await mm.initialize();
    mm.saveMessage(CHAT_ID, "user", "so na memoria");

    // o processo morrendo entre escrever o temporario e trocar o arquivo
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("morreu aqui");
    });
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    await mm.shutdown();

    expect(erro).toHaveBeenCalledWith(expect.stringContaining("Failed to save database")); // controle: a gravacao rodou e falhou
    expect(fs.readFileSync(DB).equals(v1)).toBe(true);

    mm = new MemoryManager({ dbPath: DB, windowSize: 5, dbMaxSizeMb: 500 });
    await mm.initialize(); // o banco anterior abre normalmente; afterEach desliga
    expect(mm.getRecentMessages(CHAT_ID)).toEqual([]);
  });
});

// O construtor do sql.js aceita qualquer buffer: arquivo cortado ou lixo so falham na primeira
// consulta. A recuperacao precisa pegar os dois, guardar o arquivo ruim e subir um banco novo
// em vez de derrubar o boot.
describe("banco corrompido no disco", () => {
  const estragos: [string, (bom: Buffer) => Buffer][] = [
    ["arquivo cortado em 60%", (bom) => bom.subarray(0, Math.floor(bom.length * 0.6))],
    ["bytes aleatorios", (bom) => randomBytes(bom.length)],
  ];

  it.each(estragos)("%s: guarda o arquivo em .bak e abre um banco novo e usavel", async (_nome, estragar) => {
    mm.createConversation("user-1", CHAT_ID);
    mm.saveMessage(CHAT_ID, "user", "antes");
    await mm.shutdown(); // grava em disco e zera o singleton estatico
    const ruim = estragar(fs.readFileSync(DB));
    fs.writeFileSync(DB, ruim);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});

    mm = new MemoryManager({ dbPath: DB, windowSize: 5, dbMaxSizeMb: 500 });
    await mm.initialize();

    expect(aviso).toHaveBeenCalled();
    expect(fs.readFileSync(`${DB}.bak`).equals(ruim)).toBe(true); // o que estava no disco foi guardado
    expect(mm.getConversation(CHAT_ID)).toBeNull(); // banco novo: nada do antigo
    mm.createConversation("user-1", CHAT_ID);
    expect(() => mm.saveMessage(CHAT_ID, "user", "depois")).not.toThrow();
  });
});
