import { Database } from "sql.js";

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  provider: string;
  blocked: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
  metadata: string;
  createdAt: string;
}

export interface ConversationRepository {
  create(userId: string, provider?: string): Conversation;
  findById(id: string): Conversation | null;
  findByUserId(userId: string): Conversation[];
  markBlocked(conversationId: string): void;
  isBlocked(conversationId: string): boolean;
  updateTitle(conversationId: string, title: string): void;
}

export interface MessageRepository {
  create(
    conversationId: string,
    role: string,
    content: string,
    toolName?: string,
    toolCallId?: string,
    metadata?: string
  ): Message;
  findByConversationId(conversationId: string, limit?: number): Message[];
  countByConversationId(conversationId: string): number;
  deleteOldMessages(conversationId: string, keepCount: number): number;
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private db: Database) {}

  create(userId: string, provider = "gemini"): Conversation {
    const { v4: uuidv4 } = require("uuid") as typeof import("uuid");
    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.run(
      "INSERT INTO conversations (id, user_id, title, provider, blocked, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      [id, userId, "", provider, now, now]
    );

    return this.findById(id)!;
  }

  findById(id: string): Conversation | null {
    const stmt = this.db.prepare("SELECT * FROM conversations WHERE id = ?");
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return this.mapRow(row);
    }
    stmt.free();
    return null;
  }

  findByUserId(userId: string): Conversation[] {
    const stmt = this.db.prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC");
    stmt.bind([userId]);
    const results: Conversation[] = [];
    while (stmt.step()) {
      results.push(this.mapRow(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  markBlocked(conversationId: string): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE conversations SET blocked = 1, updated_at = ? WHERE id = ?", [now, conversationId]);
  }

  isBlocked(conversationId: string): boolean {
    const stmt = this.db.prepare("SELECT blocked FROM conversations WHERE id = ?");
    stmt.bind([conversationId]);
    let blocked = false;
    if (stmt.step()) {
      blocked = (stmt.getAsObject() as { blocked: number }).blocked === 1;
    }
    stmt.free();
    return blocked;
  }

  updateTitle(conversationId: string, title: string): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", [title, now, conversationId]);
  }

  private mapRow(row: Record<string, unknown>): Conversation {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      title: String(row.title || ""),
      provider: String(row.provider || "gemini"),
      blocked: Number(row.blocked || 0),
      createdAt: String(row.created_at || ""),
      updatedAt: String(row.updated_at || ""),
    };
  }
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(private db: Database) {}

  create(
    conversationId: string,
    role: string,
    content: string,
    toolName?: string,
    toolCallId?: string,
    metadata?: string
  ): Message {
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO messages (conversation_id, role, content, tool_name, tool_call_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [conversationId, role, content, toolName || null, toolCallId || null, metadata || "{}", now]
    );

    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, conversationId]);

    const stmt = this.db.prepare("SELECT last_insert_rowid() as id");
    stmt.bind([]);
    let id = 0;
    if (stmt.step()) {
      id = Number((stmt.getAsObject() as { id: number }).id);
    }
    stmt.free();

    return {
      id,
      conversationId,
      role: role as Message["role"],
      content,
      toolName,
      toolCallId,
      metadata: metadata || "{}",
      createdAt: now,
    };
  }

  findByConversationId(conversationId: string, limit?: number): Message[] {
    const sql = limit
      ? "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC";

    const stmt = this.db.prepare(sql);
    stmt.bind(limit ? [conversationId, limit] : [conversationId]);
    const messages: Message[] = [];
    while (stmt.step()) {
      messages.push(this.mapRow(stmt.getAsObject()));
    }
    stmt.free();

    if (limit) {
      messages.reverse();
    }

    return messages;
  }

  countByConversationId(conversationId: string): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?");
    stmt.bind([conversationId]);
    let count = 0;
    if (stmt.step()) {
      count = Number((stmt.getAsObject() as { cnt: number }).cnt);
    }
    stmt.free();
    return count;
  }

  deleteOldMessages(conversationId: string, keepCount: number): number {
    const countBefore = this.countByConversationId(conversationId);

    this.db.run(
      "DELETE FROM messages WHERE conversation_id = ? AND id NOT IN (SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?)",
      [conversationId, conversationId, keepCount]
    );

    return countBefore - this.countByConversationId(conversationId);
  }

  private mapRow(row: Record<string, unknown>): Message {
    return {
      id: Number(row.id),
      conversationId: String(row.conversation_id),
      role: String(row.role) as Message["role"],
      content: String(row.content),
      toolName: row.tool_name ? String(row.tool_name) : undefined,
      toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
      metadata: String(row.metadata || "{}"),
      createdAt: String(row.created_at),
    };
  }
}