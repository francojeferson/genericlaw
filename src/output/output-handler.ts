import type { Context } from "grammy";
import type { AgentLoopResult } from "../memory/memory-manager.js";
import { EdgeTTSProcessor } from "./edge-tts.js";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const CHUNK_SIZE = 4000;

export interface OutputStrategy {
  send(ctx: Context, result: AgentLoopResult): Promise<void>;
}

export class TextOutputStrategy implements OutputStrategy {
  async send(ctx: Context, result: AgentLoopResult): Promise<void> {
    const text = result.finalResponse;

    if (text.length <= CHUNK_SIZE) {
      await ctx.reply(text);
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  }
}

export class FileOutputStrategy implements OutputStrategy {
  private tmpDir: string;

  constructor(tmpDir: string) {
    this.tmpDir = tmpDir;
  }

  async send(ctx: Context, result: AgentLoopResult): Promise<void> {
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    const filename = `output-${uuidv4()}.md`;
    const filePath = path.resolve(this.tmpDir, filename);

    try {
      fs.writeFileSync(filePath, result.finalResponse, "utf-8");
      await ctx.replyWithDocument(filePath, {
        caption: "Aqui está o documento gerado.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`File output failed: ${msg}`);
    } finally {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {}
    }
  }
}

export class AudioOutputStrategy implements OutputStrategy {
  private tts: EdgeTTSProcessor;

  constructor(tts: EdgeTTSProcessor) {
    this.tts = tts;
  }

  async send(ctx: Context, result: AgentLoopResult): Promise<void> {
    try {
      const available = await this.tts.isAvailable();
      if (!available) {
        await ctx.reply(result.finalResponse);
        return;
      }

      const audioPath = await this.tts.synthesize(result.finalResponse);
      try {
        await ctx.replyWithVoice(audioPath);
      } finally {
        try {
          if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        } catch {}
      }
    } catch {
      await ctx.reply(result.finalResponse);
    }
  }
}

export class ErrorOutputStrategy implements OutputStrategy {
  async send(ctx: Context, result: AgentLoopResult): Promise<void> {
    const msg = result.errorMessage || "Ocorreu um erro inesperado.";
    await ctx.reply(`\u26a0\ufe0f Erro: ${msg}`);
  }
}

export class TelegramOutputHandler {
  private strategies: Map<string, OutputStrategy>;
  private ctx: Context;
  private eventEmitter: EventEmitter;
  private tmpDir: string;

  constructor(ctx: Context, config: { ttsVoiceId: string; tmpDir: string }, eventEmitter: EventEmitter) {
    this.ctx = ctx;
    this.tmpDir = config.tmpDir;
    this.eventEmitter = eventEmitter;

    const tts = new EdgeTTSProcessor({ voice: config.ttsVoiceId, tempDir: config.tmpDir });

    this.strategies = new Map();
    this.strategies.set("text", new TextOutputStrategy());
    this.strategies.set("file", new FileOutputStrategy(config.tmpDir));
    this.strategies.set("audio", new AudioOutputStrategy(tts));
    this.strategies.set("error", new ErrorOutputStrategy());
  }

  async send(conversationId: string, result: AgentLoopResult): Promise<void> {
    let strategy: OutputStrategy;

    if (result.finishReason === "error") {
      strategy = this.strategies.get("error")!;
    } else if (result.outputType === "file") {
      strategy = this.strategies.get("file")!;
    } else if (result.requiresAudioReply) {
      strategy = this.strategies.get("audio")!;
    } else {
      strategy = this.strategies.get("text")!;
    }

    try {
      await strategy.send(this.ctx, result);
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.message.includes("403") || e.message.includes("Forbidden") || e.message.includes("blocked")) {
        this.eventEmitter.emit("userBlocked", { conversationId });
        return;
      }
      throw e;
    }
  }

  async sendReply(text: string): Promise<void> {
    if (text.length <= CHUNK_SIZE) {
      await this.ctx.reply(text);
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of chunks) {
      await this.ctx.reply(chunk);
    }
  }

  async sendError(text: string): Promise<void> {
    await this.ctx.reply(`\u26a0\ufe0f ${text}`);
  }
}