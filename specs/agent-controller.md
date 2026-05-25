# Spec: AgentController (Facade Central)

---

## 1. Resumo

O `AgentController` é o facade que orquestra o pipeline completo do GeneriClaw. Ele recebe o input processado do `TelegramInputHandler`, coordena o roteamento de Skills, dispara o `AgentLoop` com o provider e ferramentas corretos, persiste resultados via `MemoryManager`, e encaminha a resposta ao `TelegramOutputHandler`. Nenhum outro módulo conhece o fluxo completo — cada componente vê apenas seu contrato.

---

## 2. Contexto e Motivação

**Problema:**
Sem um orquestrador central, o `TelegramInputHandler` precisaria conhecer o `AgentLoop`, o `SkillRouter`, o `MemoryManager` e o `OutputHandler`. Isso cria acoplamento radial onde cada módulo depende de todos os outros. Uma mudança no pipeline (ex: adicionar pré-processamento) exige mexer em múltiplos arquivos sem relação clara.

**Evidências:**
O diagrama de componentes em `architecture.md` já posiciona o `AgentController` como ponto central entre Input, Skill System, AgentLoop e Memory. O PRD descreve o fluxo principal como sequência orquestrada: input -> controller -> loop -> output. Mas nenhum spec define o contrato dessa classe.

**Por que agora:**
A ausência do spec deixa ambígua a ordem de inicialização dos subsistemas, a propagação de erros entre camadas, e o contrato que cada módulo expõe ao controller. Sem isso, cada desenvolvedor implementa a cola de um jeito diferente.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir o método principal `handle(input: ProcessedInput): Promise<void>` como ponto único de entrada do pipeline.
- [ ] G-02: Orquestrar a sequência Skill Router -> AgentLoop -> Memory -> Output com propagação de erros controlada.
- [ ] G-03: Gerenciar a inicialização ordenada de todos os subsistemas.
- [ ] G-04: Garantir que nenhum módulo de domínio conheça outro diretamente — toda comunicação passa pelo Controller ou por contratos.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Acoplamento entre módulos | N módulos conhecem N outros | Cada módulo conhece apenas o Controller + contratos | MVP |
| Tempo para adicionar passo no pipeline | Alterar múltiplos arquivos | Alterar apenas AgentController | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: O Controller não toma decisões de negócio (qual skill usar, qual tool chamar). Ele apenas orquestra. Decisões são dos subsistemas.
- NG-02: O Controller não faz retry ou fallback de LLM. Isso é responsabilidade do `ProviderFactory` (ver `llm-provider.md`).
- NG-03: O Controller não gerencia ciclo de vida de processos (spawn, kill). É puramente lógico.

---

## 5. Usuários e Personas

**Usuário primário:** O `TelegramInputHandler`, que entrega `ProcessedInput` ao controller após validar whitelist e extrair texto/anexos.

**Usuário secundário:** O desenvolvedor, que adiciona novos passos ao pipeline ou depura o fluxo completo via logs do controller.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `AgentController.init()` deve inicializar todos os subsistemas na ordem correta. | Must | Chamar `init()` e receber `true` indica que DB, Skills, Tools, Providers, Input e Output estão prontos. |
| RF-02 | `AgentController.handle(input)` deve executar o pipeline completo: Skill routing -> Agent Loop -> Persistência -> Output. | Must | Uma mensagem de texto chega ao usuário como resposta sem erros não tratados. |
| RF-03 | Erro em qualquer etapa do pipeline deve ser capturado e propagado ao `ErrorOutputStrategy`. | Must | Falha no LLM gera mensagem de erro visível ao usuário, não crash silencioso. |
| RF-04 | O Controller deve logar cada transição de etapa no console para depuração. | Must | Log mostra: `[AgentController] input -> skill -> agent -> memory -> output`. |
| RF-05 | O Controller deve expor método `shutdown()` para encerramento gracioso (fechar DB, cancelar loops pendentes). | Must | `SIGTERM` ou `Ctrl+C` chama `shutdown()` e o processo termina sem corromper o SQLite. |

### 6.2 Fluxo Principal (Happy Path)

1. `TelegramInputHandler` processa mensagem e chama `controller.handle(processedInput)`.
2. Controller extrai `conversationId`, `userId` e `content` do `ProcessedInput`.
3. Controller verifica se a conversa esta bloqueada via `MemoryManager.isConversationBlocked(conversationId)`. Se bloqueada, descarta o processamento e loga: `[AgentController] Skipping message from blocked user <userId>.` O processamento para aqui.
4. Controller chama `SkillRouter.route(content, availableSkills)` para determinar skill ativa (ou `null`). `availableSkills` vem de `SkillLoader.loadAll()`.
5. Se skill ativa, controller carrega `skillContent` e metadados da skill.
6. Controller chama `MemoryManager.saveMessage(conversationId, "user", content)` para persistir a mensagem do usuario antes de carregar o historico.
7. Controller chama `MemoryManager.getRecentMessages(conversationId)` para carregar historico.
8. Controller monta o array completo de mensagens: system prompt (com tools + skill) + historico + mensagem atual. Esta e a unica etapa de assembly — o AgentLoop recebe o array pronto e nao adiciona mensagens do banco.
9. Controller obtem o provider via `ProviderFactory.createWithFallback(...)` e o injeta no AgentLoop.
10. Controller chama `AgentLoop.run(messages, provider, toolRegistry)`.
11. AgentLoop retorna `AgentLoopResult` com a resposta final.
12. Controller chama `MemoryManager.saveResponse(conversationId, result)`.
13. Controller chama `OutputHandler.send(conversationId, result)`.
14. Resposta chega ao usuario no Telegram.

**Retroactive blocking (mid-session):** Se o OutputHandler detectar erro 403 "Forbidden: bot was blocked by the user" durante o envio, ele emite um evento `userBlocked`. O AgentController captura e chama `MemoryManager.markConversationBlocked(conversationId)`. Na proxima mensagem deste usuario, o passo 3 detecta o bloqueio e descarta o processamento. Ver telegram-output.md EC-03 e Q3.

**Propagação de `requiresAudioReply`:** O flag segue o pipeline completo:
1. `TelegramInputHandler` injeta `requiresAudioReply: true` no `ProcessedInput` quando o input é voz ou contém keyword explícita (ver telegram-input.md RF-06).
2. `AgentController` repassa o flag sem modificação do `ProcessedInput` para o `AgentLoop` — ele não toma decisão sobre áudio, apenas preserva o metadado.
3. `AgentLoop` copia `input.requiresAudioReply` para `AgentLoopResult.requiresAudioReply`. O LLM NÃO pode determinar se a resposta deve ser em áudio — o flag é determinado exclusivamente pelo tipo de input (voz → áudio, texto → texto), exceto por keyword explícita no texto do usuário.
4. `OutputHandler` lê `result.requiresAudioReply` e decide a estratégia: `true` → `AudioOutputStrategy`, `false` → `TextOutputStrategy` (ou `FileOutputStrategy` se `outputType === "file"`).

A precedência é: input de voz > keyword explícita no texto > padrão texto. Se o input foi voz mas a resposta do LLM é um arquivo (`outputType === "file"`), o `outputType` prevalece sobre `requiresAudioReply` — arquivos são sempre enviados como documento, não como áudio.

### 6.2.1 System Prompt Assembly (Ownership)

O AgentController é o único responsável por montar o array completo de mensagens que o AgentLoop consome. Nenhum outro módulo adiciona conteúdo ao system prompt. A montagem segue esta estrutura e ordem:

```
[0] System message: base system prompt (definido pelo AgentController)
[1] System message: tool definitions (`toolRegistry.getToolDefinitions()`)
[2] System message: skill system prompt (se skill ativa, carregado via `SkillLoader`)
[3..N] Mensagens históricas (`memoryManager.getRecentMessages()`)
[N+1] Mensagem atual do usuário (`ProcessedInput.content`)
```

**Regras de delimitação:** Cada componente do system prompt é uma mensagem separada com `role: "system"`. A concatenação não usa delimitadores textuais — cada bloco é uma mensagem independente no array.

**Responsabilidades por componente:**

| Componente | Quem gera | Quem injeta |
|------------|-----------|-------------|
| Base system prompt | AgentController (string fixa) | AgentController |
| Tool definitions | ToolRegistry.getToolDefinitions() | AgentController |
| Skill system prompt | SkillLoader (via `SkillManifest.systemPrompt`) | AgentController |
| Histórico | MemoryManager.getRecentMessages() | AgentController |
| Mensagem atual | ProcessedInput.content | AgentController |

O AgentLoop NÃO chama `getToolDefinitions()`, NÃO consulta o banco de dados, e NÃO carrega skills. Ele recebe o array pronto via `run(messages, provider, toolRegistry)` — o `toolRegistry` é passado apenas para que o AgentLoop possa instanciar tools via `ToolFactory.create()`, não para gerar definições.

**Regra para histórico vazio (conversa nova):** Se `getRecentMessages()` retornar array vazio (EC-03: nova conversa), nenhuma mensagem histórica é inserida. O array montado é: `[0]` system prompt base, `[1]` tool definitions, `[2]` skill system prompt (se ativa), `[3]` mensagem atual do usuário. Os índices `[3..N]` colapsam — não há placeholder, gap, ou deslocamento de índices. O `[N+1]` da fórmula original equivale a `[3]` quando o histórico está vazio.

Esta seção resolve as ambiguidades.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A — Erro no AgentLoop:**
1. AgentLoop lança exceção (timeout, max iterations, LLM indisponível).
2. Controller captura e chama `OutputHandler.sendError(conversationId, error)`.
3. Usuário recebe mensagem de erro formatada.

**Fluxo Alternativo B — Sem skill correspondente:**
1. `SkillRouter.route()` retorna `null`.
2. Controller pula etapa de carregamento de skill e prossegue com o AgentLoop genérico (chatbot casual).

**Fluxo Alternativo C — Shutdown durante processamento:**
1. `shutdown()` é chamado enquanto uma mensagem está no AgentLoop.
2. Controller seta flag `isShuttingDown = true`.
3. Requisição atual conclui normalmente (não é abortada).
4. Novas requisições são rejeitadas com "Sistema em desligamento."

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Tempo de orquestração (overhead) | < 5ms | Medido como o tempo entre `handle(input)` ser chamado e `AgentLoop.run()` ser invocado, excluindo I/O de dependências (DB, FS). O controller em si apenas coordena chamadas. |
| RNF-02 | Propagação de erro | 100% | Nenhum erro escapa do pipeline sem ser logado e reportado. |

---

## 8. Design e Interface

### 8.1 ProcessedInput

```typescript
interface ProcessedInput {
  conversationId: string;
  userId: string;
  content: string;                    // texto puro (digitado ou transcrito)
  source: "text" | "voice" | "document";
  requiresAudioReply: boolean;
  voiceId?: string;                   // ex: 'pt-BR-ThalitaMultilingualNeural'
}
```

### 8.2 AgentLoopResult

```typescript
interface AgentLoopResult {
  conversationId: string;
  finalResponse: string;
  toolCallsMade: number;
  iterationsUsed: number;
  finishReason: "stop" | "max_iterations" | "error";
  requiresAudioReply: boolean;
  outputType: "text" | "file";        // se a resposta deve ser enviada como arquivo .md
  usage?: TokenUsage;                 // uso de tokens reportado pelo provider (opcional)
  errorMessage?: string;
}
```

### 8.3 AgentController

```typescript
class AgentController {
  private skillRouter: SkillRouter;
  private skillLoader: SkillLoader;
  private agentLoop: AgentLoop;
  private memoryManager: MemoryManager;
  private outputHandler: TelegramOutputHandler;
  private providerFactory: ProviderFactory;
  private isShuttingDown: boolean;
  private processingQueue: Map<string, Promise<void>>;  // conversationId -> Promise

  constructor(deps: AgentControllerDeps);

  async init(): Promise<boolean>;
  async handle(input: ProcessedInput): Promise<void>;
  async shutdown(): Promise<void>;
}
```

**Concurrency queue (`processingQueue`):** Map interno que serializa mensagens da mesma conversa. Quando `handle()` recebe `ProcessedInput`, verifica se `processingQueue` já tem uma Promise pendente para aquele `conversationId`. Se tiver, a nova mensagem aguarda (`await`) a Promise existente antes de iniciar, garantindo ordem FIFO por conversa. Conversas diferentes processam em paralelo. Limite: no máximo 5 mensagens pendentes por conversationId (ver EC-02). Timeout de stall: 5 minutos. Esta fila previne processamento concorrente dentro do mesmo processo. Para guarda de instância entre processos, ver bootstrap.md EC-05 (arquivo de lock `./data/genericlaw.lock`).
---

## 9. Modelo de Dados

O Controller não gera tabelas. Ele orquestra o `MemoryManager`, que é o dono da persistência.

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| TelegramInputHandler | Fornecedor de input | Sem input, não há pipeline para executar. |
| SkillRouter + SkillLoader | Obrigatória | Sem skills, o agente opera como chatbot genérico (fallback). |
| AgentLoop | Obrigatória | Sem loop, não há raciocínio. |
| MemoryManager | Obrigatória | Sem persistência, histórico é perdido a cada mensagem. |
| TelegramOutputHandler | Obrigatória | Sem output, resposta não chega ao usuário. |
| ProviderFactory | Obrigatória | Sem provider, não há LLM para inferência. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Falha na inicialização de subsistema | DB corrompido, skill folder ausente, provider sem API key. | `init()` retorna `false`. Controller loga qual subsistema falhou e o processo termina com código de erro. |
| EC-02: Duas mensagens concorrentes do mesmo usuário | Usuário envia segunda mensagem antes da primeira terminar. | Fila implícita por conversationId: o Controller mantém um `Map<conversationId, Promise>` interno que serializa mensagens da mesma conversa. A segunda mensagem aguarda a Promise da primeira resolver antes de iniciar. Conversas diferentes processam em paralelo. Limite: no máximo 5 mensagens pendentes por conversationId. Acima disso, mensagens são descartadas com warning: `[AgentController] Message queue full for conversation <id>. Dropping oldest pending.` Timeout de stall: se uma Promise pendente não resolver em 5 minutos, é considerada stall e descartada. |
| EC-03: Conversa nova sem histórico | Primeira mensagem de um usuário sem conversationId ativo. | Controller cria nova conversation via `MemoryManager.createConversation(userId)` e prossegue normalmente. |
| EC-04: Resultado do AgentLoop sem resposta textual | LLM retorna apenas tool calls sem texto final. | Controller usa `AgentLoopResult.finalResponse` que é sempre populado pelo loop (seja resposta do LLM ou mensagem de fallback). |

---

## 12. Segurança e Privacidade

- **Isolamento de contexto:** Cada `conversationId` é isolado. O Controller nunca cruza mensagens de conversas diferentes.
- **Propagação de erros segura:** Mensagens de erro enviadas ao usuário nunca contêm dados internos (paths, API keys, stack traces). Apenas mensagens amigáveis.
- **Log seguro:** Logs de depuração podem conter conteúdo de mensagens. Em produção, logs de conteúdo devem ser desabilitados via flag `LOG_MESSAGE_CONTENT=false`.

---

## 13. Plano de Rollout

1. Implementar `AgentController` com dependências mockadas para teste do pipeline.
2. Integrar com `TelegramInputHandler` real.
3. Integrar com `SkillRouter` e `AgentLoop` reais.
4. Adicionar `shutdown()` e testes de encerramento gracioso.
5. Adicionar logs de transição de etapa.

---

## 14. Open Questions

- Q1 (Resolvida): Atualização manual com revisão de changelog. Semver automático NÃO será usado no MVP — risco de breaking changes em dependências core (grammy, better-sqlite3) é alto demais para atualização desacompanhada. Dependabot/Renovate podem ser configurados para alertas apenas (não PR automáticos) na versão 2.
- Q2 (Deferido para quando ocorrer): Mudanças na API de polling do Telegram são abstraídas pelo Grammy. Se a API mudar de forma que o Grammy não acompanhe, o contrato `ProcessedInput` pode precisar de adaptação. Este risco é mitigado pelo fato de que o Grammy é mantido ativamente e a API de Bot do Telegram é estável desde 2015. Nenhuma ação necessária no MVP.
