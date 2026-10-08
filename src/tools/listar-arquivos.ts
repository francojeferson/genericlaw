import fs from "fs";
import path from "path";
import { BaseTool } from "./registry.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const MAX_DEPTH = 3;

export class ListarArquivosTool extends BaseTool {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
  }

  readonly definition: ToolDefinition = {
    name: "listar_arquivos",
    description:
      "Lista arquivos e diretórios no workspace. Suporta filtro por extensão de arquivo (*.md, *.ts, *.json).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Use '.' para raiz." },
        pattern: { type: "string", description: "Filtro por extensão de arquivo. Ex: '*.md', '*.ts', '*.json'. Opcional." },
      },
      required: ["path"],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const inputPath = (args.path as string) || ".";
    const pattern = args.pattern as string | undefined;

    if (path.isAbsolute(inputPath)) {
      return { success: false, output: "Erro: use caminho relativo ao workspace.", error: "absolute path" };
    }

    const resolved = path.resolve(process.cwd(), this.workspaceRoot, inputPath);
    const workspaceAbs = path.resolve(process.cwd(), this.workspaceRoot);

    if (!resolved.startsWith(workspaceAbs)) {
      return { success: false, output: "Erro: caminho fora do workspace permitido.", error: "path traversal" };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, output: `Erro: diretório não encontrado: ${inputPath}.`, error: "not found" };
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { success: false, output: `Erro: '${inputPath}' não é um diretório.`, error: "not directory" };
    }

    const extFilter = pattern ? pattern.replace("*", "") : null;
    const lines = this.listDir(resolved, workspaceAbs, extFilter, 0);

    if (lines.length === 0) {
      return { success: true, output: `Nenhum arquivo encontrado em '${inputPath}'.` };
    }

    return { success: true, output: `Arquivos em ${inputPath}:\n${lines.join("\n")}` };
  }

  private listDir(
    dirPath: string,
    workspaceAbs: string,
    extFilter: string | null,
    depth: number
  ): string[] {
    if (depth > MAX_DEPTH) return ["  (mais arquivos...)"];
    if (!dirPath.startsWith(workspaceAbs)) return [];

    const lines: string[] = [];
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const indent = "  ".repeat(depth + 1);

    for (const entry of entries) {
      const relPath = path.relative(workspaceAbs, path.join(dirPath, entry.name));

      if (entry.isDirectory()) {
        lines.push(`${indent}${relPath}/ (diretório)`);
        const subLines = this.listDir(path.join(dirPath, entry.name), workspaceAbs, extFilter, depth + 1);
        lines.push(...subLines);
      } else if (entry.isFile()) {
        if (extFilter && !entry.name.endsWith(extFilter)) continue;
        try {
          const stat = fs.statSync(path.join(dirPath, entry.name));
          lines.push(`${indent}${relPath} (${stat.size} bytes)`);
        } catch {
          lines.push(`${indent}${relPath}`);
        }
      }
    }

    return lines;
  }
}