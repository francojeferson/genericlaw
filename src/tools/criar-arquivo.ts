import fs from "fs";
import path from "path";
import { BaseTool } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

export class CriarArquivoTool extends BaseTool {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
  }

  readonly definition: ToolDefinition = {
    name: "criar_arquivo",
    description:
      "Cria ou sobrescreve um arquivo de texto no workspace. Retorna confirmação com caminho relativo e tamanho em bytes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Ex: 'specs/novo-arquivo.md'" },
        content: { type: "string", description: "Conteúdo do arquivo em UTF-8." },
      },
      required: ["path", "content"],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = args.path as string;
    const content = args.content as string;

    if (path.isAbsolute(inputPath)) {
      return { success: false, output: "Erro: use caminho relativo ao workspace.", error: "absolute path" };
    }

    const resolved = path.resolve(process.cwd(), this.workspaceRoot, inputPath);
    const workspaceAbs = path.resolve(process.cwd(), this.workspaceRoot);

    if (!resolved.startsWith(workspaceAbs)) {
      return { success: false, output: "Erro: caminho fora do workspace permitido.", error: "path traversal" };
    }

    try {
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, content, "utf-8");
      const size = Buffer.byteLength(content, "utf-8");
      return { success: true, output: `Arquivo criado: ${inputPath} (${size} bytes)` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Erro ao criar arquivo: ${msg}`, error: msg };
    }
  }
}