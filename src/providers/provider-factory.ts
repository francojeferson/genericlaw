import type { ILlmProvider, LlmMessage, LlmResponse } from "./types.js";
import { GeminiProvider } from "./gemini-provider.js";
import { DeepSeekProvider } from "./deepseek-provider.js";
import { GroqProvider } from "./groq-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";

export class ProviderFactory {
  private providers: Map<string, ILlmProvider> = new Map();

  register(name: string, provider: ILlmProvider): void {
    this.providers.set(name, provider);
  }

  create(name: string): ILlmProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider '${name}' not registered.`);
    }
    return provider;
  }

  createWithFallback(names: string[]): ILlmProvider {
    const fallbackProviders = names.map((n) => this.create(n));
    if (fallbackProviders.length === 0) {
      throw new Error("No providers configured.");
    }

    return new FallbackProvider(fallbackProviders);
  }

  getNames(): string[] {
    return Array.from(this.providers.keys());
  }

  static createFromConfig(config: {
    primaryProvider: string;
    fallbackProviders: string[];
    apiKeys: Record<string, string>;
    openRouterApiKey?: string;
    timeoutMs?: number;
    retryCount?: number;
    retryBaseDelayMs?: number;
  }): ProviderFactory {
    const factory = new ProviderFactory();

    const allProviders = [config.primaryProvider, ...config.fallbackProviders];
    const seen = new Set<string>();

    const useOpenRouter = !!config.openRouterApiKey;

    if (useOpenRouter) {
      for (const name of allProviders) {
        if (seen.has(name)) continue;
        seen.add(name);

        const provider = new OpenRouterProvider({
          name,
          apiKey: config.openRouterApiKey!,
          timeoutMs: config.timeoutMs,
          retryCount: config.retryCount,
          retryBaseDelayMs: config.retryBaseDelayMs,
        });
        factory.register(name, provider);
      }
      return factory;
    }

    for (const name of allProviders) {
      if (seen.has(name)) continue;
      seen.add(name);

      const apiKey = config.apiKeys[name];
      if (!apiKey) continue;

      const providerConfig = {
        apiKey,
        timeoutMs: config.timeoutMs,
        retryCount: config.retryCount,
        retryBaseDelayMs: config.retryBaseDelayMs,
      };

      switch (name) {
        case "gemini":
          factory.register(name, new GeminiProvider(providerConfig));
          break;
        case "deepseek":
          factory.register(name, new DeepSeekProvider(providerConfig));
          break;
        case "groq":
          factory.register(name, new GroqProvider(providerConfig));
          break;
        default:
          console.warn(`[ProviderFactory] Unknown provider '${name}', skipping.`);
      }
    }

    return factory;
  }
}

class FallbackProvider implements ILlmProvider {
  readonly name = "fallback";

  constructor(private providers: ILlmProvider[]) {}

  async generate(messages: LlmMessage[]): Promise<LlmResponse> {
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        console.info(`[FallbackProvider] Trying ${provider.name}...`);
        const response = await provider.generate(messages);
        console.info(`[FallbackProvider] ${provider.name} succeeded.`);
        return response;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[FallbackProvider] ${provider.name} failed: ${lastError.message}`);
      }
    }

    throw lastError || new Error("All providers exhausted.");
  }
}