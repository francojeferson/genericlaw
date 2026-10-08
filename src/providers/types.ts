export interface LlmMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls?: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage?: TokenUsage;
}

export interface ILlmProvider {
  readonly name: string;
  generate(messages: LlmMessage[]): Promise<LlmResponse>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; baseDelayMs: number; retryOn: number[] }
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (attempt === options.maxRetries) {
        lastError = e;
        break;
      }

      const httpStatus = (e as { status?: number }).status;
      if (httpStatus && options.retryOn.includes(httpStatus)) {
        const delay = options.baseDelayMs * Math.pow(2, attempt);
        console.warn(`[Provider] Retry ${attempt + 1}/${options.maxRetries} after ${delay}ms (status ${httpStatus})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw e;
    }
  }

  throw lastError || new Error("All retries exhausted");
}