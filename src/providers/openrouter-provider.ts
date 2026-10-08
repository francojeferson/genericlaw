import type { ILlmProvider, LlmMessage, LlmResponse, TokenUsage } from "./types.js";
import { withRetry } from "./types.js";

const MODEL_MAP: Record<string, string> = {
  gemini: "google/gemini-2.5-flash",
  deepseek: "deepseek/deepseek-chat",
  groq: "meta-llama/llama-4-maverick:free",
  nemotron: "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nemotron-super": "nvidia/nemotron-3-super-120b-a12b:free",
  "nemotron-nano": "nvidia/nemotron-3-nano-30b-a3b:free",
};

interface OpenRouterResponse {
  choices?: {
    message?: {
      content?: string;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenRouterProvider implements ILlmProvider {
  readonly name: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private retryCount: number;
  private retryBaseDelayMs: number;

  constructor(config: {
    name?: string;
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    retryCount?: number;
    retryBaseDelayMs?: number;
  }) {
    this.name = config.name || "openrouter";
    this.apiKey = config.apiKey;
    this.model = config.model || MODEL_MAP[this.name] || this.name;
    this.timeoutMs = config.timeoutMs || 120000;
    this.retryCount = config.retryCount || 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs || 1000;

    console.info(`[OpenRouter] ${this.name} -> ${this.model}`);
  }

  async generate(messages: LlmMessage[]): Promise<LlmResponse> {
    return withRetry(
      () => this._generate(messages),
      {
        maxRetries: this.retryCount,
        baseDelayMs: this.retryBaseDelayMs,
        retryOn: [429, 503],
      }
    );
  }

  private async _generate(messages: LlmMessage[]): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => {
        const entry: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.toolCallId) entry.tool_call_id = m.toolCallId;
        if (m.name) entry.name = m.name;
        return entry;
      }),
      temperature: 0.7,
      max_tokens: 8192,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": "http://localhost",
          "X-Title": "GeneriClaw",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error: Error & { status?: number } = new Error(
          `${this.name} API error: ${response.status} ${response.statusText}`
        );
        error.status = response.status;
        throw error;
      }

      const data = (await response.json()) as OpenRouterResponse;
      return this.parseResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(data: OpenRouterResponse): LlmResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      return { text: "No response from provider", finishReason: "error" };
    }

    const text = choice.message?.content || "";
    const toolCalls = choice.message?.tool_calls?.map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });

    const usage: TokenUsage | undefined = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens || 0,
          completionTokens: data.usage.completion_tokens || 0,
          totalTokens: data.usage.total_tokens || 0,
        }
      : undefined;

    let finishReason: LlmResponse["finishReason"] = "stop";
    if (choice.finish_reason === "length") finishReason = "length";
    else if (choice.finish_reason === "tool_calls" || (toolCalls && toolCalls.length > 0)) {
      finishReason = "tool_calls";
    }

    return { text, toolCalls, finishReason, usage };
  }
}