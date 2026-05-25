# Spec: LLM Provider System (Provedores de IA)

---

## 1. Resumo

O sistema de provedores abstrai a comunicação com APIs externas de LLM (Gemini, DeepSeek, Groq). Ele define uma interface uniforme (`ILlmProvider`) que o Agent Loop consome sem saber qual provedor está ativo. Uma `ProviderFactory` seleciona e instancia o provedor configurado, com fallback automático em caso de falha.

---

## 2. Contexto e Motivação

**Problema:**
APIs de LLM têm formatos de request/response diferentes. Gemini usa REST com `generateContent`. DeepSeek usa formato OpenAI-compatible. Trocar de provedor sem uma camada de abstração exige refatorar o Agent Loop inteiro.

**Evidências:**
O PRD e a arquitetura mencionam "troca dinâmica de LLMs" e "ProviderFactory com fallback" mas nenhum spec define o contrato, o modelo de autenticação, ou a cadeia de retry.

**Por que agora:**
Sem essa especificação, cada desenvolvedor implementa o provider de um jeito diferente. A padronização garante que adicionar um novo provedor (ex: Claude, GPT-4) exija apenas uma nova classe que implementa `ILlmProvider`, sem tocar no Agent Loop.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir a interface `ILlmProvider` com método único `generate(messages): Promise<LlmResponse>`.
- [ ] G-02: A `ProviderFactory` deve instanciar o provedor correto a partir de uma string de configuração (`LLM_PROVIDER`).
- [ ] G-03: Implementar fallback automático: se o provedor primário falhar, tentar o próximo da cadeia configurada.
- [ ] G-04: Todo provider deve formatar mensagens do formato interno do GeneriClaw para o formato nativo da API alvo.
- [ ] G-05: Suportar retry com exponential backoff para erros transientes (429, 503).

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo para adicionar novo provider | Sem padrão | < 30 min (1 arquivo) | MVP |
| Fallback bem-sucedido | Não implementado | < 2s para troca | MVP |
| Retry em 429/503 | Não implementado | Recuperação automática | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Não faremos streaming de respostas (chunks SSE). A resposta chega completa antes de ser processada.
- NG-02: Não suportaremos provedores self-hosted (Ollama, LM Studio) no MVP. O foco inicial são APIs cloud.
- NG-03: O provider não gerencia tokens nem calcula custos. Isso é responsabilidade do Memory Manager (truncamento).

---

## 5. Usuários e Personas

**Usuário primário:** O Agent Loop, que chama `provider.generate(messages)` e recebe `LlmResponse`.

**Usuário secundário:** O desenvolvedor, que implementa novos providers extendendo `BaseLlmProvider`.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `ILlmProvider.generate(messages)` recebe array de mensagens no formato interno e retorna `LlmResponse`. | Must | Qualquer classe implementando a interface funciona com o Agent Loop sem alterações. |
| RF-02 | `ProviderFactory.create(providerName)` instancia o provider pelo nome. | Must | Passar `"gemini"` retorna instância de `GeminiProvider`. |
| RF-03 | O factory aceita uma lista ordenada de providers para fallback. | Must | Configurar `LLM_PROVIDERS=gemini,deepseek` faz com que falha no Gemini acione DeepSeek automaticamente. |
| RF-04 | Cada provider implementa `formatMessages(internalMessages): ProviderSpecificFormat`. | Must | Mensagens do formato interno `{ role, content }` viram o formato exato da API alvo. |
| RF-05 | Retry com exponential backoff: 1s, 2s, 4s (máx 3 tentativas, alinhado com `LLM_RETRY_COUNT=3`) para erros 429 e 503. A sequencia de delays e gerada com base em `LLM_RETRY_COUNT` e `LLM_RETRY_BASE_DELAY_MS` — com count=3 e base=1000, os delays sao 1s, 2s, 4s. | Must | Rate limit temporário não interrompe o fluxo do usuário. |
| RF-06 | `LlmResponse` contém `{ text: string, toolCalls?: ToolCall[], finishReason: string, usage?: TokenUsage }`. | Must | O Agent Loop extrai `text` para resposta direta ou `toolCalls` para execução de ferramenta. |

### 6.2 Fluxo Principal (Happy Path)

1. Agent Loop chama `provider.generate(messages)`.
2. Provider formata as mensagens para o schema da API alvo.
3. Provider envia requisição HTTP com API key do `.env`.
4. API retorna resposta com texto ou tool calls.
5. Provider converte a resposta nativa para `LlmResponse`.
6. Agent Loop recebe `LlmResponse` e decide: responder ao usuário ou executar tool.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A — Fallback por falha (transparente ao AgentLoop):**
1. Provider primário (Gemini) retorna 503 após 3 tentativas de retry esgotadas.
2. O proxy de fallback (criado por `ProviderFactory.createWithFallback()`) detecta a falha e instancia o próximo provider da cadeia (DeepSeek).
3. O proxy refaz a chamada com o novo provider, sem que o AgentLoop perceba a troca.
4. Se todos os providers da cadeia falharem, o proxy propaga o erro ao AgentLoop, que o repassa ao AgentController.
5. O AgentController encaminha o erro ao OutputHandler, que notifica o usuário.

**Fluxo Alternativo B — Retry bem-sucedido:**
1. Provider retorna 429 (rate limit).
2. Sistema espera 1s e retry.
3. Segunda tentativa também 429. Espera 2s.
4. Terceira tentativa retorna 200. Resposta normal.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Timeout por requisição | 120s | Alinhado com o timeout do Agent Loop. |
| RNF-02 | Tamanho máximo de resposta | 64KB | O provider retorna a resposta completa da API sem truncamento. O limite de 64KB é aplicado downstream pelo MemoryManager na persistência (ver memory.md EC-03). O AgentLoop opera com a resposta completa em RAM — o truncamento ocorre apenas na gravação no banco de dados. |
| RNF-03 | Isolamento de provider | 100% | Falha em um provider não afeta instâncias de outros providers. |

---

## 8. Design e Interface

### 8.1 Interface ILlmProvider

```typescript
interface LlmMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;  // Deferido para v2: reservado para tool call responses com identificação do agente. Não populado no MVP. Ver Q4.
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

**Consumo de TokenUsage:** O `TokenUsage` é retornado por cada provider via `LlmResponse.usage` (campo opcional — providers que não reportam uso retornam `undefined`). O `MemoryManager.saveResponse()` persiste `TokenUsage` no campo `metadata` da mensagem (coluna `messages.metadata` como JSON) para auditoria e análise de custos. O `AgentLoop` também loga `TokenUsage` no console ao final de cada iteração: `[AgentLoop] Tokens: prompt=<N>, completion=<N>, total=<N>`. Nenhum módulo bloqueia ou toma decisão com base em `TokenUsage` no MVP — é puramente informacional. Truncamento de contexto é baseado em contagem de mensagens (`MEMORY_WINDOW_SIZE`), não em contagem de tokens.

```typescript
interface LlmResponse {
  text: string;
  toolCalls?: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage?: TokenUsage;
}

interface ILlmProvider {
  readonly name: string;
  generate(messages: LlmMessage[]): Promise<LlmResponse>;
}
```

### 8.2 ProviderFactory

```typescript
class ProviderFactory {
  private providers: Map<string, ILlmProvider> = new Map();

  register(name: string, provider: ILlmProvider): void;
  create(name: string): ILlmProvider;
  createWithFallback(names: string[]): ILlmProvider;  // retorna proxy com fallback
}
```

### 8.3 Retry Logic

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; baseDelayMs: number; retryOn: number[] }
): Promise<T>;
```

---

## 9. Modelo de Dados

Não gera tabelas SQLite. Estado é transiente durante a requisição.

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| Agent Loop | Consumidor | Sem Agent Loop, providers não são chamados. |
| API Keys (.env) | Obrigatória | Sem chave, provider não autentica. Erro fatal na inicialização. |
| Rede (HTTP) | Obrigatória | Sem internet, todas as chamadas falham. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: API key inválida | 401 ou 403 da API. | Provider retorna `LlmResponse` com `finishReason: "error"` e mensagem descritiva. NÃO tenta retry. NÃO faz fallback (todas as keys podem estar inválidas). |
| EC-02: Resposta malformada | API retorna JSON que não segue o schema esperado. | Parse failure vira `LlmResponse` com `finishReason: "error"` e `text: "Falha ao interpretar resposta do provedor."` |
| EC-03: Tool call com JSON inválido nos argumentos | API retorna `arguments` como string que não faz parse para JSON. | Provider tenta `JSON.parse`. Se falhar, tool call é ignorado e `text` da resposta é usado como fallback. |
| EC-04: Timeout de rede | Requisição excede 120s. | AbortController cancela. Tratado como erro transiente → retry ou fallback. |
| EC-05: Todos os providers esgotados | Nenhum provider da cadeia respondeu com sucesso. | Erro propagado ao Agent Loop, que responde ao usuário: "Todos os provedores de IA estão indisponíveis no momento." |

---

## 12. Segurança e Privacidade

- **API Keys:** Carregadas exclusivamente do `.env` via `process.env`. Nunca logadas, nunca incluídas em mensagens de erro visíveis ao usuário.
- **Dados em trânsito:** Toda comunicação com APIs externas usa HTTPS. Nenhum dado trafega em texto plano.
- **Sanitização de erros:** Mensagens de erro enviadas ao usuário nunca contêm a API key, mesmo que o erro original da API a inclua (ex: URL com key no path).

---

## 13. Plano de Rollout

1. Implementar `ILlmProvider` e classes base.
2. Implementar `GeminiProvider` (provider primário inicial).
3. Implementar `ProviderFactory` com fallback.
4. Adicionar `DeepSeekProvider`.
5. Adicionar `GroqProvider`.
6. Integrar com Agent Loop.

---

## 14. Open Questions

- Q1 (Resolvida): Truncamento hard no byte 65536, executado pelo MemoryManager ao persistir a resposta no banco (ver memory.md Q3). O provider retorna a resposta completa. O AgentLoop opera com a resposta completa em RAM. Apenas na persistência o conteúdo é truncado.
- Q2 (Resolvida): NG-02 cobre apenas LLMs self-hosted (Ollama, LM Studio, llama.cpp local). Whisper local e Edge-TTS são dependências de sistema explicitamente incluídas no escopo do MVP para STT/TTS.
- Q3 (Resolvida): Mock de HTTP com `nock` ou `msw`. Cada provider terá testes unitários que interceptam chamadas HTTP e retornam respostas pré-definidas (200 com tool calls, 429, 503, JSON malformado). Testes de integração do ProviderFactory validam a cadeia de fallback com providers mockados.
- Q4 (Deferido para v2): Campo `name` na interface `LlmMessage` não é populado no MVP. Reservado para respostas de tool call que identifiquem o agente ou função chamadora (ex: OpenAI function calling usa `name` para associar respostas de função ao nome da função). Será populado quando tool calls retornarem resultados com identificação explícita do executor.
