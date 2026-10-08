import fs from "fs";
import path from "path";
import { BaseTool } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const DEFAULT_MAX_BYTES = 65536;

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
        maxBytes: { type: "number", description: "Limite opcional de bytes a ler. Padrão: 65536 (64KB)." },
      },
      required: ["path"],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = args.path as string;
    const maxBytes = (args.maxBytes as number) || DEFAULT_MAX_BYTES;

    if (path.isAbsolute(inputPath)) {
      return { success: false, output: "Erro: use caminho relativo ao workspace.", error: "absolute path" };
    }

    const resolved = path.resolve(process.cwd(), this.workspaceRoot, inputPath);
    const workspaceAbs = path.resolve(process.cwd(), this.workspaceRoot);

    if (!resolved.startsWith(workspaceAbs)) {
      return { success: false, output: "Erro: caminho fora do workspace permitido.", error: "path traversal" };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, output: `Erro: arquivo não encontrado: ${inputPath}.`, error: "not found" };
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { success: false, output: `Erro: '${inputPath}' é um diretório, não um arquivo.`, error: "is directory" };
    }

    try {
      const fullContent = fs.readFileSync(resolved, "utf-8");
      const buf = Buffer.from(fullContent, "utf-8");

      if (buf.length > maxBytes) {
        console.warn(
          `[LerArquivoTool] Arquivo truncado de ${buf.length} para ${maxBytes} bytes.`
        );
        const truncated = buf.subarray(0, maxBytes).toString("utf-8");
        return { success: true, output: truncated };
      }

      return { success: true, output: fullContent };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "Erro: arquivo não é texto UTF-8 válido.", error: msg };
    }
  }
}