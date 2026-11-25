import initSqlJs, { type Database } from "sql.js";
import fs from "fs";
import path from "path";
import {
  SqliteConversationRepository,
  SqliteMessageRepository,
  type ConversationRepository,
  type MessageRepository,
  type Conversation,
  type Message,
} from "./repositories.js";
import { SqliteGroupMessageRepository, normalizar, type GroupMessage } from "./group-repository.js";

export interface AgentLoopResult {
  conversationId: string;
  finalResponse: string;
  toolCallsMade: number;
  iterationsUsed: number;
  finishReason: "stop" | "max_iterations" | "error";
  requiresAudioReply: boolean;
  usage?: TokenUsage;
  errorMessage?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const MAX_CONTENT_BYTES = 65536;
const VACUUM_INTERVAL = 500;

export class MemoryManager {
  private static dbInstance: Database | null = null;

  private db!: Database;
  private conversationRepo!: ConversationRepository;
  private messageRepo!: MessageRepository;
  private groupRepo!: SqliteGroupMessageRepository;
  private insertCounter = 0;
  private dirty = false;
  private isShutdown = false;
  private dbPath: string;
  private windowSize: number;
  private dbMaxSizeMb: number;
  private saveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: { dbPath: string; windowSize: number; dbMaxSizeMb: number }) {
    this.dbPath = config.dbPath;
    this.windowSize = config.windowSize;
    this.dbMaxSizeMb = config.dbMaxSizeMb;
  }

  async initialize(): Promise<void> {
    if (MemoryManager.dbInstance) {
      this.db = MemoryManager.dbInstance;
    } else {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const SQL = await initSqlJs();

      if (fs.existsSync(this.dbPath)) {
        try {
          const buffer = fs.readFileSync(this.dbPath);
          this.db = new SQL.Database(buffer);
          // o construtor aceita qualquer buffer: arquivo cortado ou lixo so falha na primeira
          // consulta, que antes rodava fora deste try e derrubava o boot sem recuperacao
          this.db.exec("SELECT 1 FROM sqlite_master");
        } catch {
          console.warn(`[MemoryManager] Database file corrupted, creating new one. Backing up old file.`);
          const bakPath = this.dbPath + ".bak";
          try { fs.copyFileSync(this.dbPath, bakPath); } catch { /* ignore */ }
          this.db = new SQL.Database();
        }
      } else {
        this.db = new SQL.Database();
      }

      // sem journal_mode aqui: o sql.js e um build wasm em memoria, entao WAL nao faz nada
      this.db.run("PRAGMA foreign_keys=ON;");
      this.db.run("PRAGMA auto_vacuum=INCREMENTAL;");

      this.runMigrations();
      MemoryManager.dbInstance = this.db;
    }

    this.conversationRepo = new SqliteConversationRepository(this.db);
    this.messageRepo = new SqliteMessageRepository(this.db);
    this.groupRepo = new SqliteGroupMessageRepository(this.db);
    this.isShutdown = false;

    this.startAutoSave();

    this.checkDbSize();
  }

  private startAutoSave(): void {
    this.saveInterval = setInterval(() => {
      this.saveToDisk();
    }, 5000);
  }

  private saveToDisk(): void {
    if (!this.db || this.isShutdown || !this.dirty) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      // temporario + rename: gravar por cima do arquivo deixava o banco cortado se o
      // processo morresse no meio da escrita, e o rename troca o arquivo de uma vez
      const tmpPath = this.dbPath + ".tmp";
      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, this.dbPath);
      this.dirty = false;
      // o arquivo acabou de ser escrito, entao o tamanho em disco e o real.
      // Antes isso so era checado no boot e o limite nunca valia durante o uso.
      this.checkDbSize();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MemoryManager] Failed to save database: ${msg}`);
    }
  }

  async shutdown(): Promise<void> {
    // precisa rodar antes de isShutdown ser setado: saveToDisk() aborta com essa flag ligada
    this.saveToDisk();
    this.isShutdown = true;

    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }

    if (this.db) {
      this.db.close();
      MemoryManager.dbInstance = null;
    }
  }

  private ensureInitialized(): void {
    if (this.isShutdown) {
      throw new Error("MemoryManager is shut down.");
    }
    if (!this.db) {
      throw new Error("MemoryManager not initialized. Call initialize() first.");
    }
  }

  private runMigrations(): void {
    // Mudanca de schema tambem e escrita: sem isso a guarda de flag suja em
    // saveToDisk() descarta a migracao e o arquivo mantem o schema anterior.
    this.dirty = true;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        title         TEXT DEFAULT '',
        provider      TEXT NOT NULL DEFAULT 'gemini',
        blocked       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)");
    // nenhuma consulta busca conversa por usuario; o indice so custava uma escrita a mais
    this.db.run("DROP INDEX IF EXISTS idx_conversations_user_id");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        content         TEXT NOT NULL,
        tool_name       TEXT,
        tool_call_id    TEXT,
        metadata        TEXT DEFAULT '{}',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `);

    // Toda consulta de mensagem ordena por id, nao por created_at (ver repositories.ts),
    // entao o indice antigo em created_at forcava uma ordenacao. O indice por role nao era
    // usado por consulta nenhuma; ambos custavam uma escrita a cada insercao.
    // Nome novo de proposito: CREATE INDEX IF NOT EXISTS manteria silenciosamente a
    // definicao antiga do indice num banco ja existente.
    // Sem FK para conversations e fora da poda por janela: e historico de grupo,
    // nao contexto de conversa. A PK composta e o que torna o backfill idempotente.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_messages (
        chat_id     TEXT NOT NULL,
        msg_id      INTEGER NOT NULL,
        chat_title  TEXT NOT NULL DEFAULT '',
        sender      TEXT NOT NULL DEFAULT '',
        text        TEXT NOT NULL,
        date        TEXT NOT NULL,
        text_norm   TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (chat_id, msg_id)
      )
    `);

    // Ate onde o destilador ja leu cada grupo. Tabela propria em vez de coluna:
    // a marca d'agua e por grupo, nao por mensagem.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS group_digest (
        chat_id     TEXT PRIMARY KEY,
        last_msg_id INTEGER NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `);

    this.migrateTextNorm();

    this.db.run("CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id)");
    this.db.run("DROP INDEX IF EXISTS idx_messages_conversation");
    this.db.run("DROP INDEX IF EXISTS idx_messages_role");
  }

  /**
   * text_norm entrou depois que a tabela ja tinha historico coletado. Em banco
   * novo o CREATE TABLE acima ja a cria e nada acontece aqui; em banco existente
   * a coluna e adicionada e preenchida uma unica vez, senao a busca nao acharia
   * nada do que foi coletado antes.
   */
  private migrateTextNorm(): void {
    const info = this.db.exec("PRAGMA table_info(group_messages)");
    const colunas = info.length ? info[0].values.map((v) => String(v[1])) : [];
    if (colunas.includes("text_norm")) return;

    this.db.run("ALTER TABLE group_messages ADD COLUMN text_norm TEXT NOT NULL DEFAULT ''");

    const linhas = this.db.exec("SELECT chat_id, msg_id, text FROM group_messages");
    if (!linhas.length) return;

    const stmt = this.db.prepare("UPDATE group_messages SET text_norm = ? WHERE chat_id = ? AND msg_id = ?");
    try {
      for (const [chatId, msgId, text] of linhas[0].values) {
        stmt.run([normalizar(String(text)), String(chatId), Number(msgId)]);
      }
    } finally {
      stmt.free();
    }
    console.info(`[MemoryManager] text_norm preenchido em ${linhas[0].values.length} mensagem(ns) de grupo.`);
  }

  private checkDbSize(): void {
    if (!fs.existsSync(this.dbPath)) return;
    const stat = fs.statSync(this.dbPath);
    const sizeMb = stat.size / (1024 * 1024);
    if (sizeMb > this.dbMaxSizeMb) {
      console.warn(`[MemoryManager] Database size ${sizeMb.toFixed(1)}MB exceeds limit ${this.dbMaxSizeMb}MB. Running VACUUM.`);
      this.db.run("VACUUM");
      // marcar sujo em vez de gravar aqui: saveToDisk() e quem chama este metodo
      this.dirty = true;
    }
  }

  private sanitizeContent(content: string): string {
    content = content.replace(/\u0000/g, "");
    const buf = Buffer.from(content, "utf-8");
    if (buf.length > MAX_CONTENT_BYTES) {
      let truncated = buf.subarray(0, MAX_CONTENT_BYTES).toString("utf-8");
      while (Buffer.from(truncated, "utf-8").length > MAX_CONTENT_BYTES) {
        truncated = truncated.slice(0, -1);
      }
      console.warn(`[MemoryManager] Message content truncated from ${buf.length} to ${Buffer.from(truncated, "utf-8").length} bytes.`);
      return truncated;
    }
    return content;
  }

  private maybeVacuum(): void {
    this.insertCounter++;
    if (this.insertCounter >= VACUUM_INTERVAL) {
      this.db.run("PRAGMA incremental_vacuum");
      this.insertCounter = 0;
    }
  }

  /**
   * Repositorio do historico de grupos. Escritas por aqui precisam marcar o banco
   * como sujo, senao o autosave de 5s as descarta — dai o wrapper em vez do repo cru.
   */
  get groupMessages(): SqliteGroupMessageRepository {
    this.ensureInitialized();
    return this.groupRepo;
  }

  /** Grava mensagens de grupo e devolve quantas eram novas. */
  saveGroupMessages(messages: GroupMessage[]): number {
    this.ensureInitialized();
    const inserted = this.groupRepo.save(messages);
    if (inserted > 0) this.dirty = true;
    return inserted;
  }

  /** Avanca a marca d'agua do destilador. Wrapper pelo mesmo motivo de saveGroupMessages. */
  saveDigestWatermark(chatId: string, msgId: number): void {
    this.ensureInitialized();
    this.groupRepo.setDigestWatermark(chatId, msgId);
    this.dirty = true;
  }

  createConversation(userId: string, id?: string): Conversation {
    this.dirty = true;
    this.ensureInitialized();
    return this.conversationRepo.create(userId, id);
  }

  getConversation(conversationId: string): Conversation | null {
    this.ensureInitialized();
    return this.conversationRepo.findById(conversationId);
  }

  saveMessage(
    conversationId: string,
    role: "user" | "assistant" | "system" | "tool",
    content: string,
    toolName?: string,
    toolCallId?: string,
    metadata?: string
  ): Message {
    this.ensureInitialized();
    this.dirty = true;
    const sanitized = this.sanitizeContent(content);
    const msg = this.messageRepo.create(conversationId, role, sanitized, toolName, toolCallId, metadata);
    this.maybeVacuum();

    const count = this.messageRepo.countByConversationId(conversationId);
    if (count > this.windowSize * 4) {
      this.truncateOldMessages(conversationId);
    }

    return msg;
  }

  saveResponse(conversationId: string, result: AgentLoopResult, delivered?: string): void {
    this.ensureInitialized();
    const metadata: Record<string, unknown> = {};
    if (result.usage) {
      metadata.usage = result.usage;
    }
    // o que de fato chegou ao usuario: "voice", "text", "voice+text", "error"...
    if (delivered) metadata.delivered = delivered;
    metadata.finishReason = result.finishReason;
    metadata.toolCallsMade = result.toolCallsMade;
    metadata.iterationsUsed = result.iterationsUsed;

    this.saveMessage(conversationId, "assistant", result.finalResponse, undefined, undefined, JSON.stringify(metadata));
  }

  getRecentMessages(conversationId: string): Message[] {
    this.ensureInitialized();
    return this.messageRepo.findByConversationId(conversationId, this.windowSize);
  }

  /** Apaga o historico de mensagens mas mantem a linha da conversa e seus arquivos. */
  clearMessages(conversationId: string): number {
    this.dirty = true;
    this.ensureInitialized();
    return this.messageRepo.deleteByConversationId(conversationId);
  }

  truncateOldMessages(conversationId: string): number {
    this.ensureInitialized();
    return this.messageRepo.deleteOldMessages(conversationId, this.windowSize);
  }
}