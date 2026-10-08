import type { Bot, Context } from "grammy";
import type { AgentController } from "../core/agent-controller.js";
import type { AppConfig } from "../config.js";
import type { ProcessedInput } from "./types.js";
import { WhisperProcessor } from "./whisper-processor.js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

const AUDIO_KEYWORDS = ["responda em audio", "responda em áudio", "fale comigo"];

export class TelegramInputHandler {
  private bot: Bot;
  private whisper: WhisperProcessor;
  private allowedUserIds: string[];
  private tmpDir: string;
  private controller: AgentController;
  private ffmpegBinary: string;
  private voiceEnabled: boolean;

  constructor(config: {
    bot: Bot;
    controller: AgentController;
    config: AppConfig;
  }) {
    this.bot = config.bot;
    this.controller = config.controller;
    this.allowedUserIds = config.config.telegram.allowedUserIds;
    this.tmpDir = config.config.filesystem.tmpDir;
    this.ffmpegBinary = config.config.audio.ffmpegBinary;
    this.voiceEnabled = true;

    const modelPath = path.resolve(
      `./models/whisper/ggml-${config.config.audio.whisperModel}.bin`
    );
    this.whisper = new WhisperProcessor({
      modelPath,
      binaryPath: config.config.audio.whisperBinary,
    });
  }

  async start(): Promise<void> {
    this.bot.on("message:text", (ctx) => this.handleText(ctx));
    this.bot.on(["message:voice", "message:audio"], (ctx) => this.handleVoice(ctx));
    this.bot.on("message:document", (ctx) => this.handleDocument(ctx));

    console.info("[TelegramInputHandler] Starting polling...");
    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private isWhitelisted(userId: number): boolean {
    return this.allowedUserIds.includes(String(userId));
  }

  private buildProcessedInput(
    ctx: Context,
    content: string,
    source: ProcessedInput["source"],
    requiresAudioReply: boolean
  ): ProcessedInput {
    return {
      conversationId: String(ctx.chat!.id),
      userId: String(ctx.from!.id),
      content,
      source,
      requiresAudioReply,
    };
  }

  private detectAudioKeyword(text: string): boolean {
    const lower = text.toLowerCase();
    return AUDIO_KEYWORDS.some((kw) => lower.includes(kw));
  }

  private async handleText(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isWhitelisted(userId)) return;

    const text = ctx.message?.text || "";
    if (!text.trim()) return;

    await ctx.replyWithChatAction("typing");

    const requiresAudioReply = this.detectAudioKeyword(text);
    const input = this.buildProcessedInput(ctx, text, "text", requiresAudioReply);
    await this.controller.handle(input, ctx);
  }

  private async handleVoice(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isWhitelisted(userId)) return;
    if (!this.voiceEnabled) {
      await ctx.reply("Voz desabilitada: dependências de áudio não encontradas.");
      return;
    }

    const msg = ctx.message as Record<string, unknown> | undefined;
    const voice =
      ctx.message?.voice ||
      (msg?.audio as { file_id: string } | undefined);
    if (!voice) return;

    const fileId = (voice as { file_id: string }).file_id;
    if (!fileId) return;

    await ctx.replyWithChatAction("typing");

    let oggPath: string | null = null;
    let wavPath: string | null = null;

    try {
      oggPath = await this.downloadFile(fileId, "ogg");

      wavPath = path.resolve(this.tmpDir, `${path.basename(oggPath, ".ogg")}.wav`);
      await this.convertToWav(oggPath, wavPath);

      const whisperAvailable = await this.whisper.isAvailable();
      if (!whisperAvailable) {
        await ctx.reply("Voz desabilitada: Whisper não está disponível no momento.");
        return;
      }

      const transcript = await this.whisper.transcribe(wavPath);

      if (!transcript.trim()) {
        await ctx.reply("Áudio vazio captado. Pode reenviar?");
        return;
      }

      const input = this.buildProcessedInput(ctx, transcript, "voice", true);
      await this.controller.handle(input, ctx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TelegramInputHandler] Voice processing error: ${msg}`);
      await ctx.reply("\u26a0\ufe0f Falha ao processar o áudio: arquivo grande demais ou falha no serviço.");
    } finally {
      if (oggPath) try { fs.unlinkSync(oggPath); } catch {}
      if (wavPath) try { fs.unlinkSync(wavPath); } catch {}
    }
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isWhitelisted(userId)) return;

    const doc = ctx.message?.document;
    if (!doc) return;

    const fileName = doc.file_name || "";
    const mimeType = doc.mime_type || "";
    const isPdf = mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");
    const isMarkdown = fileName.toLowerCase().endsWith(".md");

    if (!isPdf && !isMarkdown) {
      await ctx.reply("\u26a0\ufe0f No momento, só consigo processar texto estruturado (.md), áudio e PDF.");
      return;
    }

    await ctx.replyWithChatAction("typing");

    let downloadedPath: string | null = null;

    try {
      const ext = isPdf ? "pdf" : "md";
      downloadedPath = await this.downloadFile(doc.file_id, ext);

      let text: string;
      if (isMarkdown) {
        text = fs.readFileSync(downloadedPath, "utf-8");
      } else {
        text = await this.extractPdfText(downloadedPath);
      }

      if (!text.trim()) {
        if (isPdf) {
          await ctx.reply("\u26a0\ufe0f Este PDF parece conter apenas imagens escaneadas. Não foi possível extrair texto.");
        } else {
          await ctx.reply("\u26a0\ufe0f Arquivo vazio.");
        }
        return;
      }

      const input = this.buildProcessedInput(ctx, text, "document", false);
      await this.controller.handle(input, ctx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TelegramInputHandler] Document processing error: ${msg}`);
      await ctx.reply("\u26a0\ufe0f Não foi possível extrair texto deste PDF. Ele pode estar protegido por senha ou criptografado.");
    } finally {
      if (downloadedPath) try { fs.unlinkSync(downloadedPath); } catch {}
    }
  }

  private async downloadFile(fileId: string, ext: string): Promise<string> {
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    const file = await this.bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

    const outputPath = path.resolve(this.tmpDir, `download-${Date.now()}.${ext}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    return outputPath;
  }

  private async convertToWav(oggPath: string, wavPath: string): Promise<void> {
    try {
      await execFileAsync(this.ffmpegBinary, [
        "-i", oggPath,
        "-ar", "16000",
        "-ac", "1",
        "-sample_fmt", "s16",
        wavPath,
        "-y",
      ], { timeout: 30000 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ffmpeg conversion failed: ${msg}`);
    }
  }

  private async extractPdfText(filePath: string): Promise<string> {
    const pdfParse = (await import("pdf-parse")).default;
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }
}