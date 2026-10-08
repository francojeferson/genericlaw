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

export interface AgentLoopResult {
  conversationId: string;
  finalResponse: string;
  toolCallsMade: number;
  iterationsUsed: number;
  finishReason: "stop" | "max_iterations" | "error";
  requiresAudioReply: boolean;
  outputType: "text" | "file";
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
  private insertCounter = 0;
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
        } catch {
          console.warn(`[MemoryManager] Database file corrupted, creating new one. Backing up old file.`);
          const bakPath = this.dbPath + ".bak";
          try { fs.copyFileSync(this.dbPath, bakPath); } catch { /* ignore */ }
          this.db = new SQL.Database();
        }
      } else {
        this.db = new SQL.Database();
      }

      this.db.run("PRAGMA journal_mode=WAL;");
      this.db.run("PRAGMA foreign_keys=ON;");
      this.db.run("PRAGMA auto_vacuum=INCREMENTAL;");

      this.runMigrations();
      MemoryManager.dbInstance = this.db;
    }

    this.conversationRepo = new SqliteConversationRepository(this.db);
    this.messageRepo = new SqliteMessageRepository(this.db);
    this.isShutdown = false;

    this.startAutoSave();

    await this.checkDbSize();
  }

  private startAutoSave(): void {
    this.saveInterval = setInterval(() => {
      this.saveToDisk();
    }, 5000);
  }

  private saveToDisk(): void {
    if (!this.db || this.isShutdown) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MemoryManager] Failed to save database: ${msg}`);
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;

    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }

    this.saveToDisk();

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

    this.db.run("CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)");

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

    this.db.run("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(conversation_id, role)");
  }

  private async checkDbSize(): Promise<void> {
    if (!fs.existsSync(this.dbPath)) return;
    const stat = fs.statSync(this.dbPath);
    const sizeMb = stat.size / (1024 * 1024);
    if (sizeMb > this.dbMaxSizeMb) {
      console.warn(`[MemoryManager] Database size ${sizeMb.toFixed(1)}MB exceeds limit ${this.dbMaxSizeMb}MB. Running VACUUM.`);
      this.db.run("VACUUM");
      this.saveToDisk();
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

  createConversation(userId: string, provider?: string): Conversation {
    this.ensureInitialized();
    return this.conversationRepo.create(userId, provider);
  }

  getConversation(conversationId: string): Conversation | null {
    this.ensureInitialized();
    return this.conversationRepo.findById(conversationId);
  }

  getConversationsByUser(userId: string): Conversation[] {
    this.ensureInitialized();
    return this.conversationRepo.findByUserId(userId);
  }

  updateConversationTitle(conversationId: string, title: string): void {
    this.ensureInitialized();
    this.conversationRepo.updateTitle(conversationId, title);
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
    const sanitized = this.sanitizeContent(content);
    const msg = this.messageRepo.create(conversationId, role, sanitized, toolName, toolCallId, metadata);
    this.maybeVacuum();

    const count = this.messageRepo.countByConversationId(conversationId);
    if (count > this.windowSize * 4) {
      this.truncateOldMessages(conversationId);
    }

    return msg;
  }

  saveResponse(conversationId: string, result: AgentLoopResult): void {
    this.ensureInitialized();
    const metadata: Record<string, unknown> = {};
    if (result.usage) {
      metadata.usage = result.usage;
    }
    metadata.finishReason = result.finishReason;
    metadata.toolCallsMade = result.toolCallsMade;
    metadata.iterationsUsed = result.iterationsUsed;
    metadata.outputType = result.outputType;

    this.saveMessage(conversationId, "assistant", result.finalResponse, undefined, undefined, JSON.stringify(metadata));
  }

  getRecentMessages(conversationId: string): Message[] {
    this.ensureInitialized();
    return this.messageRepo.findByConversationId(conversationId, this.windowSize);
  }

  markConversationBlocked(conversationId: string): void {
    this.ensureInitialized();
    this.conversationRepo.markBlocked(conversationId);
  }

  isConversationBlocked(conversationId: string): boolean {
    this.ensureInitialized();
    return this.conversationRepo.isBlocked(conversationId);
  }

  truncateOldMessages(conversationId: string): number {
    this.ensureInitialized();
    return this.messageRepo.deleteOldMessages(conversationId, this.windowSize);
  }
}