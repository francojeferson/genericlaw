import type { ILlmProvider, LlmMessage, LlmResponse, TokenUsage } from "./types.js";
import { withRetry } from "./types.js";
import type { ToolDefinition, ToolParameter } from "../tools/registry.js";

interface GeminiContent {
  role: string;
  parts: { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }[];
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }[];
      role?: string;
    };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiProvider implements ILlmProvider {
  readonly name = "gemini";
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private retryCount: number;
  private retryBaseDelayMs: number;

  constructor(config: {
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    retryCount?: number;
    retryBaseDelayMs?: number;
  }) {
    this.apiKey = config.apiKey;
    this.model = config.model || "gemini-2.0-flash";
    this.timeoutMs = config.timeoutMs || 120000;
    this.retryCount = config.retryCount ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  async generate(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
    return withRetry(
      () => this._generate(messages, tools),
      {
        maxRetries: this.retryCount,
        baseDelayMs: this.retryBaseDelayMs,
        retryOn: [429, 503],
      }
    );
  }

  private async _generate(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmResponse> {
    const contents = this.formatMessages(messages);
    const toolDeclarations = tools && tools.length > 0 ? this.toGeminiDeclarations(tools) : [];

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
      },
    };

    if (toolDeclarations.length > 0) {
      body.tools = [{ functionDeclarations: toolDeclarations }];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}?key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error: Error & { status?: number } = new Error(`Gemini API error: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      const data = (await response.json()) as GeminiResponse;
      return this.parseResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  private formatMessages(messages: LlmMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    const systemMessages: string[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemMessages.push(msg.content);
        continue;
      }

      const role = msg.role === "assistant" ? "model" : "user";
      const parts: GeminiContent["parts"] = [{ text: msg.content }];

      if (msg.role === "tool") {
        contents.push({
          role: "user",
          parts: [{ text: `Tool result: ${msg.content}` }],
        });
        continue;
      }

      contents.push({ role, parts });
    }

    if (systemMessages.length > 0) {
      contents.unshift({ role: "user", parts: [{ text: systemMessages.join("\n\n") }] });
      contents.unshift({ role: "model", parts: [{ text: "Entendido. Vou seguir essas instruções." }] });
    }

    return contents;
  }

  // O Gemini quer o enum de tipo em maiusculas, e `required` apenas como array no objeto -
  // nunca o booleano por propriedade que nosso ToolParameter carrega.
  private toGeminiSchema(p: ToolParameter): Record<string, unknown> {
    const schema: Record<string, unknown> = {
      type: p.type.toUpperCase(),
      description: p.description,
    };
    if (p.enum) schema.enum = p.enum;
    if (p.items) schema.items = this.toGeminiSchema(p.items);
    if (p.properties) {
      schema.properties = Object.fromEntries(
        Object.entries(p.properties).map(([k, v]) => [k, this.toGeminiSchema(v)])
      );
      const nested = Object.entries(p.properties).filter(([, v]) => v.required).map(([k]) => k);
      if (nested.length > 0) schema.required = nested;
    }
    return schema;
  }

  private toGeminiDeclarations(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: "OBJECT",
        properties: Object.fromEntries(
          Object.entries(t.parameters.properties).map(([k, v]) => [k, this.toGeminiSchema(v)])
        ),
        required: t.parameters.required,
      },
    }));
  }

  private parseResponse(data: GeminiResponse): LlmResponse {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      return { text: "No response from Gemini", finishReason: "error" };
    }

    const parts = candidate.content?.parts || [];
    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text!)
      .join("\n");

    const functionCalls = parts.filter((p) => p.functionCall);
    let toolCalls = undefined;

    if (functionCalls.length > 0) {
      toolCalls = functionCalls.map((fc, i) => ({
        id: `gemini-call-${i}`,
        name: fc.functionCall!.name,
        arguments: fc.functionCall!.args || {},
      }));
    }

    const usage: TokenUsage | undefined = data.usageMetadata
      ? {
          promptTokens: data.usageMetadata.promptTokenCount || 0,
          completionTokens: data.usageMetadata.candidatesTokenCount || 0,
          totalTokens: data.usageMetadata.totalTokenCount || 0,
        }
      : undefined;

    let finishReason: LlmResponse["finishReason"] = "stop";
    if (candidate.finishReason === "STOP") finishReason = "stop";
    else if (candidate.finishReason === "MAX_TOKENS") finishReason = "length";

    if (toolCalls && toolCalls.length > 0) {
      finishReason = "tool_calls";
    }

    return { text, toolCalls, finishReason, usage };
  }
}