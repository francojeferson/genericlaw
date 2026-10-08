import type { ILlmProvider, LlmMessage, LlmResponse } from "../providers/types.js";
import type { ToolRegistry, ITool, ToolResult } from "../tools/registry.js";
import type { AgentLoopResult } from "../memory/memory-manager.js";

const BASE_SYSTEM_PROMPT = `Você é o GeneriClaw, um agente pessoal de IA executando localmente no desktop do usuário.
Você responde comandos recebidos via Telegram, tem acesso a ferramentas de filesystem e pode gerar documentos.

Regras:
1. Responda SEMPRE em português do Brasil (pt-BR).
2. Seja direto e conciso.
3. Use ferramentas quando necessário para ler ou criar arquivos.
4. Se precisar criar um arquivo .md, use a ferramenta criar_arquivo.
5. Se a resposta do usuário for curta e casual, responda em texto puro.
6. Se gerar um documento, indique claramente o nome do arquivo criado.
7. Nunca invente resultados de ferramentas — execute-as primeiro.`;

const MARKDOWN_FILE_REGEX = /```(?:markdown|md)\s*(?:\n|.)*?(?:[a-zA-Z0-9_\-/.]+\.md)/i;

export class AgentLoop {
  private maxIterations: number;
  private toolTimeoutMs: number;

  constructor(config: { maxIterations: number; toolTimeoutMs: number }) {
    this.maxIterations = config.maxIterations;
    this.toolTimeoutMs = config.toolTimeoutMs;
  }

  getBaseSystemPrompt(): string {
    return BASE_SYSTEM_PROMPT;
  }

  async run(
    messages: LlmMessage[],
    provider: ILlmProvider,
    toolRegistry: ToolRegistry
  ): Promise<AgentLoopResult> {
    let toolCallsMade = 0;
    let iterationsUsed = 0;
    let totalUsage = undefined;

    const conversationMessages = [...messages];

    for (let i = 0; i < this.maxIterations; i++) {
      iterationsUsed = i + 1;
      console.info(`[AgentLoop] Iteration ${iterationsUsed}/${this.maxIterations}`);

      let response: LlmResponse;
      try {
        response = await provider.generate(conversationMessages);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[AgentLoop] Provider failed: ${msg}`);
        return {
          conversationId: "",
          finalResponse: "Desculpe, todos os provedores de IA estão indisponíveis no momento.",
          toolCallsMade,
          iterationsUsed,
          finishReason: "error",
          requiresAudioReply: false,
          outputType: "text",
          errorMessage: msg,
        };
      }

      if (response.usage) {
        totalUsage = response.usage;
        console.info(
          `[AgentLoop] Tokens: prompt=${response.usage.promptTokens}, completion=${response.usage.completionTokens}, total=${response.usage.totalTokens}`
        );
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        toolCallsMade++;

        if (response.toolCalls.length > 1) {
          const ignored = response.toolCalls.slice(1).map((tc) => tc.name);
          console.warn(
            `[AgentLoop] LLM returned ${response.toolCalls.length} tool calls; only the first is executed. Ignored: [${ignored.join(", ")}]`
          );
        }

        const toolCall = response.toolCalls[0];

        conversationMessages.push({
          role: "assistant",
          content: response.text || `Calling tool: ${toolCall.name}`,
        });

        const toolResult = await this.executeTool(toolCall.name, toolCall.arguments, toolRegistry);

        conversationMessages.push({
          role: "tool",
          content: toolResult.output,
          toolCallId: toolCall.id,
        });

        console.info(`[AgentLoop] Tool ${toolCall.name} executed: ${toolResult.success ? "success" : "failure"}`);
        continue;
      }

      const outputType = this.detectOutputType(response.text);
      console.info(`[AgentLoop] Final response (${outputType})`);

      return {
        conversationId: "",
        finalResponse: response.text,
        toolCallsMade,
        iterationsUsed,
        finishReason: "stop",
        requiresAudioReply: false,
        outputType,
        usage: totalUsage,
      };
    }

    console.warn("[AgentLoop] Max iterations reached.");
    return {
      conversationId: "",
      finalResponse: "Desculpe, desisti ou deu timeout no processamento pois falhei nas chamadas em MAX iterações.",
      toolCallsMade,
      iterationsUsed,
      finishReason: "max_iterations",
      requiresAudioReply: false,
      outputType: "text",
      usage: totalUsage,
    };
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    toolRegistry: ToolRegistry
  ): Promise<ToolResult> {
    if (!toolRegistry.has(name)) {
      const available = toolRegistry.getToolNames().join(", ");
      return {
        success: false,
        output: `Tool '${name}' não disponível. Ferramentas disponíveis: ${available}`,
        error: "tool not found",
      };
    }

    let tool: ITool;
    try {
      tool = toolRegistry.get(name);
    } catch {
      return {
        success: false,
        output: `Erro ao instanciar tool '${name}'.`,
        error: "instantiation error",
      };
    }

    const validation = tool.validateArgs(args);
    if (!validation.valid) {
      return {
        success: false,
        output: `Argumentos inválidos: ${validation.errors?.join(", ")}. Corrija e reenvie.`,
        error: "invalid args",
      };
    }

    try {
      const result = await Promise.race([
        tool.execute(args),
        new Promise<ToolResult>((resolve) =>
          setTimeout(
            () => resolve({ success: false, output: `Error: Tool execution timed out after ${this.toolTimeoutMs / 1000}s.`, error: "timeout" }),
            this.toolTimeoutMs
          )
        ),
      ]);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Error: ${msg}`, error: msg };
    }
  }

  private detectOutputType(text: string): "text" | "file" {
    if (MARKDOWN_FILE_REGEX.test(text)) {
      return "file";
    }
    return "text";
  }
}