import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { AgentLoopResult } from "../memory/memory-manager.js";
import { EdgeTTSProcessor } from "./edge-tts.js";
import fs from "fs";

const CHUNK_SIZE = 4000;

// o edge-tts escala mal: ~500 chars levam 9s, ~3000 levam 78s, ~7000 nunca terminou.
// Um audio de varios minutos tambem e ruim de ouvir, entao a parte falada tem teto e
// a resposta completa vai em seguida como texto.
const TTS_MAX_CHARS = 2000;

/**
 * O que de fato saiu para o usuario. Pedir audio nao e receber audio: quando o
 * edge-tts falha a resposta vira texto, e so este valor distingue os dois casos.
 */
export type Delivered = "text" | "voice" | "voice+text" | "error" | "none";

export interface OutputStrategy {
  send(ctx: Context, result: AgentLoopResult): Promise<Delivered>;
}

export class TextOutputStrategy implements OutputStrategy {
  async send(ctx: Context, result: AgentLoopResult): Promise<Delivered> {
    // o Telegram recusa texto vazio com 400; nunca deixar um chegar na API
    const text = result.finalResponse?.trim() || "(resposta vazia)";

    if (text.length <= CHUNK_SIZE) {
      await ctx.reply(text);
      return "text";
    }

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
    return "text";
  }
}

export class AudioOutputStrategy implements OutputStrategy {
  private tts: EdgeTTSProcessor;
  // os dois caminhos de fallback passam pelo divisor de blocos: ctx.reply() recusa
  // qualquer coisa acima de 4096 chars, entao uma resposta longa falhava duas vezes
  private readonly text = new TextOutputStrategy();

  constructor(tts: EdgeTTSProcessor) {
    this.tts = tts;
  }

  async send(ctx: Context, result: AgentLoopResult): Promise<Delivered> {
    try {
      const available = await this.tts.isAvailable();
      if (!available) {
        return this.text.send(ctx, result);
      }

      const full = result.finalResponse;
      const abbreviated = full.length > TTS_MAX_CHARS;
      const spoken = abbreviated
        ? `${full.slice(0, TTS_MAX_CHARS)} ... Resposta abreviada. O texto completo segue na próxima mensagem.`
        : full;

      const audioPath = await this.tts.synthesize(spoken);
      try {
        // o grammy trata uma string crua como file_id ou URL; um caminho do Windows vira
        // uma URL com porta invalida. Arquivos locais precisam ir dentro de InputFile.
        await ctx.replyWithVoice(new InputFile(audioPath));
      } finally {
        try {
          if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        } catch {}
      }

      // nada se perde quando a resposta era longa demais para narrar
      if (abbreviated) {
        await this.text.send(ctx, result);
        return "voice+text";
      }
      return "voice";
    } catch (err: unknown) {
      // cair para texto e o certo, mas fazer isso em silencio escondia um pipeline de
      // audio quebrado atras do que parecia uma resposta normal
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AudioOutputStrategy] Voice reply failed, sending text instead: ${msg}`);
      return this.text.send(ctx, result);
    }
  }
}

export class ErrorOutputStrategy implements OutputStrategy {
  async send(ctx: Context, result: AgentLoopResult): Promise<Delivered> {
    // a mensagem escrita para o usuario vem primeiro; errorMessage e detalhe de API,
    // util no log e nao no chat. So vale como ultimo recurso porque o Telegram
    // recusa texto vazio com 400.
    const msg = result.finalResponse?.trim() || result.errorMessage || "Ocorreu um erro inesperado.";
    await ctx.reply(`\u26a0\ufe0f ${msg}`);
    return "error";
  }
}

export class TelegramOutputHandler {
  private strategies: Map<string, OutputStrategy>;
  private ctx: Context;

  constructor(ctx: Context, config: { ttsVoiceId: string; tmpDir: string; edgeTtsBinary?: string; ffmpegBinary?: string }) {
    this.ctx = ctx;

    const tts = new EdgeTTSProcessor({
      voice: config.ttsVoiceId,
      tempDir: config.tmpDir,
      binary: config.edgeTtsBinary,
      ffmpegBinary: config.ffmpegBinary,
    });

    this.strategies = new Map();
    this.strategies.set("text", new TextOutputStrategy());
    this.strategies.set("audio", new AudioOutputStrategy(tts));
    this.strategies.set("error", new ErrorOutputStrategy());
  }

  async send(result: AgentLoopResult): Promise<Delivered> {
    let strategy: OutputStrategy;

    if (result.finishReason === "error") {
      strategy = this.strategies.get("error")!;
    } else if (result.requiresAudioReply) {
      strategy = this.strategies.get("audio")!;
    } else {
      strategy = this.strategies.get("text")!;
    }

    // um envio que falha (inclusive o 403 de quem bloqueou o bot) sobe para o controller,
    // que loga o erro de pipeline; nada marca a conversa, entao desbloquear o bot basta
    return strategy.send(this.ctx, result);
  }

  async sendError(text: string): Promise<void> {
    await this.ctx.reply(`\u26a0\ufe0f ${text.trim() || "Erro desconhecido."}`);
  }
}