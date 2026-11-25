import fs from "fs";
import path from "path";
import { BaseTool, resolveInWorkspace, truncateUtf8, isInsideWorkspace, delimitarNaoConfiavel } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { DIR_CONHECIMENTO, FONTE_DESTILADO } from "../knowledge/distiller.js";

// O resultado de uma tool fica no contexto do loop em todas as iteracoes seguintes, entao
// uma leitura grande e paga varias vezes. O teto NAO e sobrescrevivel: um modelo pediu
// maxBytes=200000 e levou um prompt a 121k tokens. Ele pagina com offset no lugar.
const DEFAULT_MAX_BYTES = 8192;
const MAX_BYTES_CEILING = 32768;

export class LerArquivoTool extends BaseTool {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
  }

  readonly definition: ToolDefinition = {
    name: "ler_arquivo",
    description: "Lê o conteúdo de um arquivo de texto do workspace. Retorna o conteúdo como string UTF-8.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Ex: 'specs/PRD.md'" },
        maxBytes: { type: "number", description: "Bytes a ler nesta chamada. Padrão: 8192 (8KB). Máximo: 32768 (32KB) — valores maiores são reduzidos a esse limite." },
        offset: { type: "number", description: "Byte inicial da leitura. Padrão: 0. Para ler um arquivo grande, repita a chamada usando o offset indicado no final da resposta anterior." },
      },
      required: ["path"],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = args.path as string;
    const requested = Number(args.maxBytes) || DEFAULT_MAX_BYTES;
    const maxBytes = Math.min(Math.max(1, requested), MAX_BYTES_CEILING);
    const offset = Math.max(0, Number(args.offset) || 0);

    if (path.isAbsolute(inputPath)) {
      return { success: false, output: "Erro: use caminho relativo ao workspace.", error: "absolute path" };
    }

    const resolved = resolveInWorkspace(this.workspaceRoot, inputPath);
    if (!resolved) {
      return { success: false, output: "Erro: caminho fora do workspace permitido.", error: "path traversal" };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, output: `Erro: arquivo não encontrado: ${inputPath}.`, error: "not found" };
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { success: false, output: `Erro: '${inputPath}' é um diretório, não um arquivo.`, error: "is directory" };
    }

    // O destilado de conhecimento/ e texto de terceiros: volta ao agente como dado cercado, igual
    // a mensagem de grupo lida direto. Pelo caminho resolvido, entao "./conhecimento/x" tambem cai aqui.
    const destilado = isInsideWorkspace(path.resolve(process.cwd(), this.workspaceRoot, DIR_CONHECIMENTO), resolved);
    const cercar = (texto: string) => (destilado ? delimitarNaoConfiavel(texto, FONTE_DESTILADO) : texto);

    try {
      const fullContent = fs.readFileSync(resolved, "utf-8");
      const buf = Buffer.from(fullContent, "utf-8");

      if (offset >= buf.length && buf.length > 0) {
        return {
          success: false,
          output: `Erro: offset ${offset} está além do fim do arquivo (${buf.length} bytes).`,
          error: "offset out of range",
        };
      }

      const end = Math.min(buf.length, offset + maxBytes);
      let chunk = buf.subarray(offset, end).toString("utf-8");

      if (end < buf.length) {
        // nunca emitir um caractere que o corte partiu ao meio; o offset fica na fronteira
        chunk = chunk.replace(/�+$/, "");
        const nextOffset = offset + Buffer.byteLength(chunk, "utf-8");
        console.warn(`[LerArquivoTool] Leitura parcial: bytes ${offset}-${nextOffset} de ${buf.length}.`);
        // o modelo precisa saber que nao viu o arquivo inteiro; o aviso e nosso, entao fica fora da cerca
        return {
          success: true,
          output: `${cercar(chunk)}\n\n[...leitura parcial: bytes ${offset}-${nextOffset} de ${buf.length}. Chame ler_arquivo novamente com offset=${nextOffset} para continuar.]`,
        };
      }

      return { success: true, output: cercar(chunk) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "Erro: arquivo não é texto UTF-8 válido.", error: msg };
    }
  }
}