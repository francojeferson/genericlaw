# Spec: AgentController (Facade Central)

---

## 1. Resumo

O `AgentController` e o facade que orquestra o pipeline completo do GeneriClaw. Ele recebe o input processado do `TelegramInputHandler`, coordena o roteamento de Skills, dispara o `AgentLoop` com o provider e ferramentas corretos, persiste resultados via `MemoryManager`, e encaminha a resposta ao `TelegramOutputHandler`. Nenhum outro modulo conhece o fluxo completo - cada componente ve apenas seu contrato.

---

## 2. Contexto e Motivacao

**Problema:**
Sem um orquestrador central, o `TelegramInputHandler` precisaria conhecer o `AgentLoop`, o `SkillRouter`, o `MemoryManager` e o `OutputHandler`. Isso cria acoplamento radial onde cada modulo depende de todos os outros. Uma mudanca no pipeline (ex: adicionar pre-processamento) exige mexer em multiplos arquivos sem relacao clara.

**Evidencias:**
O diagrama de componentes em `architecture.md` ja posiciona o `AgentController` como ponto central entre Input, Skill System, AgentLoop e Memory. O PRD descreve o fluxo principal como sequencia orquestrada: input -> controller -> loop -> output. Mas nenhum spec define o contrato dessa classe.

**Por que agora:**
A ausencia do spec deixa ambigua a ordem de inicializacao dos subsistemas, a propagacao de erros entre camadas, e o contrato que cada modulo expoe ao controller. Sem isso, cada desenvolvedor implementa a cola de um jeito diferente.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir o metodo principal `handle(input: ProcessedInput): Promise<void>` como ponto unico de entrada do pipeline.
- [ ] G-02: Orquestrar a sequencia Skill Router -> AgentLoop -> Memory -> Output com propagacao de erros controlada.
- [ ] G-03: Gerenciar a inicializacao ordenada de todos os subsistemas.
- [ ] G-04: Garantir que nenhum modulo de dominio conheca outro diretamente - toda comunicacao passa pelo Controller ou por contratos.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Acoplamento entre modulos | N modulos conhecem N outros | Cada modulo conhece apenas o Controller + contratos | MVP |
| Tempo para adicionar passo no pipeline | Alterar multiplos arquivos | Alterar apenas AgentController | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: O Controller nao toma decisoes de negocio (qual skill usar, qual tool chamar). Ele apenas orquestra. Decisoes sao dos subsistemas.
- NG-02: O Controller nao faz retry ou fallback de LLM. Isso e responsabilidade do `ProviderFactory` (ver `llm-provider.md`).
- NG-03: O Controller nao gerencia ciclo de vida de processos (spawn, kill). E puramente logico.

---

## 5. Usuarios e Personas

**Usuario primario:** O `TelegramInputHandler`, que entrega `ProcessedInput` ao controller apos validar whitelist e extrair texto/anexos.

**Usuario secundario:** O desenvolvedor, que adiciona novos passos ao pipeline ou depura o fluxo completo via logs do controller.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `AgentController.init()` deve inicializar todos os subsistemas na ordem correta. | Must | Chamar `init()` e receber `true` indica que DB, Skills, Tools, Providers, Input e Output estao prontos. |
| RF-02 | `AgentController.handle(input)` deve executar o pipeline completo: Skill routing -> Agent Loop -> Persistencia -> Output. | Must | Uma mensagem de texto chega ao usuario como resposta sem erros nao tratados. |
| RF-03 | Erro em qualquer etapa do pipeline deve ser capturado e propagado ao `ErrorOutputStrategy`. | Must | Falha no LLM gera mensagem de erro visivel ao usuario, nao crash silencioso. |
| RF-04 | O Controller deve logar cada transicao de etapa no console para depuracao. | Must | Log mostra: `[AgentController] input -> skill -> agent -> memory -> output`. |
| RF-05 | O Controller deve expor metodo `shutdown()` para encerramento gracioso (fechar DB, cancelar loops pendentes). | Must | `SIGTERM` ou `Ctrl+C` chama `shutdown()` e o processo termina sem corromper o SQLite. |

### 6.2 Fluxo Principal (Happy Path)

1. `TelegramInputHandler` processa mensagem e chama `controller.handle(processedInput)`.
2. Controller extrai `conversationId`, `userId` e `content` do `ProcessedInput`.
3. Controller chama `SkillRouter.route(content, availableSkills)` para determinar skill ativa (ou `null`). `availableSkills` vem de `SkillLoader.loadAll()`.
4. Se skill ativa, controller carrega `skillContent` e metadados da skill.
5. Controller chama `MemoryManager.saveMessage(conversationId, "user", content)` para persistir a mensagem do usuario antes de carregar o historico.
6. Controller chama `MemoryManager.getRecentMessages(conversationId)` para carregar historico.
7. Controller monta o array completo de mensagens: system prompt (com tools + skill) + historico + mensagem atual. Esta e a unica etapa de assembly - o AgentLoop recebe o array pronto e nao adiciona mensagens do banco.
8. Controller obtem o provider via `ProviderFactory.createWithFallback(...)` e o injeta no AgentLoop.
9. Controller chama `AgentLoop.run(messages, provider, toolRegistry)`.
10. AgentLoop retorna `AgentLoopResult` com a resposta final. O Controller preenche
    `result.conversationId` e `result.requiresAudioReply` a partir do `ProcessedInput` - o AgentLoop
    sempre devolve esses dois campos vazios, porque nao conhece a origem da mensagem.
11. Controller chama `OutputHandler.send(result)`, que devolve um `Delivered`
    dizendo o que de fato saiu (`"voice"`, `"text"`, `"voice+text"`, `"error"`).
12. Num `finally`, Controller chama `MemoryManager.saveResponse(conversationId, result, delivered)`
    e loga `[AgentController] delivered: <valor>`.
13. Resposta chega ao usuario no Telegram.

**Por que o save vem depois do envio.** `delivered` so existe apos a tentativa de envio, e e o
unico campo que distingue "pediu audio e recebeu audio" de "pediu audio e o TTS caiu para texto" -
`requiresAudioReply` registra o pedido, nao a entrega. O `finally` garante que a resposta e
persistida mesmo quando o envio falha; a janela de perda (processo morrer entre envio e gravacao)
ja existia pelo autosave de 5s do `MemoryManager`.

**Falha de envio (inclui o 403 de quem bloqueou o bot):** o erro sobe do `send()`; o `finally` ainda grava a resposta (com `delivered = "none"`) e o `catch` do `process()` loga o erro de pipeline. Nada marca a conversa como bloqueada: um flag que nenhum caminho limpava trancava o dono para fora, em silencio, depois de um bloqueio e desbloqueio. Ver telegram-output.md EC-03 e Q3.

**Propagacao de `requiresAudioReply`:** O flag segue o pipeline completo:
1. `TelegramInputHandler` injeta `requiresAudioReply: true` no `ProcessedInput` quando o input e voz ou contem keyword explicita (ver telegram-input.md RF-06).
2. `AgentController` repassa o flag sem modificacao do `ProcessedInput` para o `AgentLoop` - ele nao toma decisao sobre audio, apenas preserva o metadado.
3. O `AgentLoop` **nao** conhece o flag: ele sempre devolve `requiresAudioReply: false`, e o
   `AgentController` sobrescreve o campo com o valor do `ProcessedInput` ao receber o resultado. O
   LLM nao pode determinar se a resposta deve ser em audio - o flag vem exclusivamente do tipo de
   input (voz -> audio, texto -> texto), exceto por keyword explicita no texto do usuario.
4. `OutputHandler` decide a estrategia: `finishReason === "error"` -> `ErrorOutputStrategy`; senao `requiresAudioReply` -> `AudioOutputStrategy`; senao `TextOutputStrategy`.
5. A estrategia devolve o que entregou, e esse valor - nao o flag - e o que fica gravado no
   `metadata` da mensagem (ver passo 12 do fluxo principal e `telegram-output.md` 8.2).

A precedencia e: erro de provider > input de voz > keyword explicita no texto > padrao texto. Arquivos gerados nao afetam a escolha: eles sao criados no `WORKSPACE_ROOT` pela tool `criar_arquivo` e apenas citados na resposta.

### 6.2.1 System Prompt Assembly (Ownership)

O AgentController e o unico responsavel por montar o array completo de mensagens que o AgentLoop consome. Nenhum outro modulo adiciona conteudo ao system prompt. A montagem segue esta estrutura e ordem:

```
[0] System message: base system prompt (`agentLoop.getBaseSystemPrompt()`)
[1] System message: skill system prompt (se skill ativa, via `SkillManifest.systemPrompt`)
[2..N] Mensagens historicas (`memoryManager.getRecentMessages()`)
```

**Nao existe mensagem de tool definitions.** As `ToolDefinition` vao ao provider pelo campo nativo
de function calling, nunca como texto de prompt (ver `agent-loop.md` 8.3).

**A mensagem atual do usuario nao e anexada separadamente.** O Controller chama
`saveMessage(conversationId, "user", content)` **antes** de `getRecentMessages()`, entao o historico
ja termina com o turno atual. Empurra-lo de novo duplicaria a pergunta no prompt.

**Regras de delimitacao:** Cada componente do system prompt e uma mensagem separada com `role: "system"`. A concatenacao nao usa delimitadores textuais - cada bloco e uma mensagem independente no array.

**Responsabilidades por componente:**

| Componente | Quem gera | Quem injeta |
|------------|-----------|-------------|
| Base system prompt | AgentLoop.getBaseSystemPrompt() | AgentController |
| Skill system prompt | SkillLoader (via `SkillManifest.systemPrompt`) | AgentController |
| Historico (ja inclui o turno atual) | MemoryManager.getRecentMessages() | AgentController |
| Tool definitions | ToolRegistry.getToolDefinitions() | **AgentLoop**, via `provider.generate()` - nunca no prompt |

O AgentLoop NAO consulta o banco de dados e NAO carrega skills: recebe o array de mensagens pronto via `run(messages, provider, toolRegistry)`. O `toolRegistry` serve para duas coisas: resolver a tool a executar (`get(name)`) e obter as `ToolDefinition` entregues ao provider como function declarations nativas a cada iteracao. O AgentController **nao** injeta tools no prompt - descreve-las em texto nao habilita function calling e apenas consome tokens.

**Regra para historico vazio (conversa nova):** nao existe esse caso na pratica. Como a mensagem do
usuario e salva antes da leitura, `getRecentMessages()` devolve no minimo um elemento - o turno
atual. Um retorno vazio aqui significa `MEMORY_WINDOW_SIZE` invalido, que a validacao de config
agora recusa no boot (ver `configuration.md` 3).

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A - Erro no AgentLoop:**
1. AgentLoop lanca excecao (timeout, max iterations, LLM indisponivel).
2. Controller captura e chama `OutputHandler.sendError(conversationId, error)`.
3. Usuario recebe mensagem de erro formatada.

**Fluxo Alternativo B - Sem skill correspondente:**
1. `SkillRouter.route()` retorna `null`.
2. Controller pula etapa de carregamento de skill e prossegue com o AgentLoop generico (chatbot casual).

**Fluxo Alternativo C - Shutdown durante processamento:**
1. `shutdown()` e chamado enquanto uma mensagem esta no AgentLoop (SIGINT, SIGTERM ou `/parar`).
2. Controller seta `isShuttingDown = true` e aguarda as promises pendentes com `Promise.allSettled`.
3. O raciocinio em voo **conclui**, mas a resposta **nao e enviada**: o passo de envio checa
   `isShuttingDown` e a descarta. A mensagem ainda e persistida, com `delivered: "none"`.
4. Novas mensagens sao rejeitadas antes de qualquer processamento.

**Consequencia conhecida:** quem manda `/parar` logo apos uma pergunta pode nunca ver a resposta,
mesmo ela estando no banco. E o preco de encerrar rapido; se o comportamento desejado fosse o
oposto, o envio precisaria acontecer antes de a flag subir.

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Tempo de orquestracao (overhead) | < 5ms | Medido como o tempo entre `handle(input)` ser chamado e `AgentLoop.run()` ser invocado, excluindo I/O de dependencias (DB, FS). O controller em si apenas coordena chamadas. |
| RNF-02 | Propagacao de erro | 100% | Nenhum erro escapa do pipeline sem ser logado e reportado. |

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
  private toolRegistry: ToolRegistry;
  private providerFactory: ProviderFactory;
  private config: AppConfig;
  private isShuttingDown: boolean;
  private processingQueue: Map<string, Promise<void>>;  // conversationId -> ultima promise
  private pendingCount: Map<string, number>;            // conversationId -> quantas na fila

  constructor(deps: AgentControllerDeps);                // nao ha init(): o construtor so guarda deps

  async handle(input: ProcessedInput, ctx: Context): Promise<void>;
  resetConversation(conversationId: string): number;     // /novo - delega a clearMessages
  async shutdown(): Promise<void>;
}
```

**Nao existe `init()`.** O construtor apenas guarda as dependencias ja inicializadas. Quem
inicializa subsistemas e o bootstrap, antes de construir o Controller.

**O `TelegramOutputHandler` nao e um campo.** Ele e construido por mensagem dentro de `process()`,
porque encapsula o `Context` daquele update do grammy - um handler de longa duracao responderia
sempre ao mesmo chat.

**Concurrency queue (`processingQueue` + `pendingCount`):** `processingQueue` guarda a **ultima**
promise de cada conversa; uma mensagem nova aguarda essa promise antes de comecar, o que serializa
a conversa em FIFO. Conversas diferentes correm em paralelo. `pendingCount` conta quantas estao na
fila e rejeita a partir de 5 (EC-02) - sem ele, a fila nao teria como se medir, ja que o Map guarda
uma unica entrada por conversa.

**Timer de stall:** a espera pela promise anterior corre contra um `setTimeout` de 5 minutos
(`Promise.race`). Se ele vence, o loga-se o stall e a mensagem segue em paralelo com a anterior. O
timer e **cancelado num `finally`** - sem o `clearTimeout`, cada mensagem enfileirada segurava o
event loop por 5 minutos depois de o trabalho ter terminado.

Esta fila previne processamento concorrente **dentro do mesmo processo**. Nao ha guarda entre
processos: duas instancias com o mesmo `TELEGRAM_BOT_TOKEN` disputam o polling (ver `bootstrap.md`
EC-05).

---

## 9. Modelo de Dados

O Controller nao gera tabelas. Ele orquestra o `MemoryManager`, que e o dono da persistencia.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| TelegramInputHandler | Fornecedor de input | Sem input, nao ha pipeline para executar. |
| SkillRouter + SkillLoader | Obrigatoria | Sem skills, o agente opera como chatbot generico (fallback). |
| AgentLoop | Obrigatoria | Sem loop, nao ha raciocinio. |
| MemoryManager | Obrigatoria | Sem persistencia, historico e perdido a cada mensagem. |
| TelegramOutputHandler | Obrigatoria | Sem output, resposta nao chega ao usuario. |
| ProviderFactory | Obrigatoria | Sem provider, nao ha LLM para inferencia. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Falha na inicializacao de subsistema | DB corrompido, provider sem API key, token invalido. | Tratado inteiramente no **bootstrap**, antes de o Controller existir (ver `bootstrap.md` 5). O Controller nao tem `init()` e nao valida subsistemas. |
| EC-02: Duas mensagens concorrentes do mesmo usuario | Usuario envia segunda mensagem antes da primeira terminar. | Fila por conversationId (ver 8.3). A segunda aguarda a promise da primeira antes de iniciar; conversas diferentes correm em paralelo. A partir de 5 pendentes, a nova e **recusada na entrada** - nao se descarta a mais antiga - com warning `[AgentController] Queue full for conversation <id>; rejecting this message.` e um aviso ao usuario no chat. Se a promise anterior nao resolver em 5 minutos, o stall e logado e a mensagem segue em paralelo. |
| EC-05: Falha ao rotear skill | `SkillRouter.route()` lanca (provider fora do ar, JSON invalido). | Capturado e tratado como `skillName = null`: o turno segue no agente raiz. Uma falha de roteamento nunca derruba a mensagem. O `SkillRouter` loga um warning `[SkillRouter] ... continuing without a skill` com o motivo; antes a falha era silenciosa. |
| EC-06: Erro nao tratado no pipeline | Qualquer excecao entre o roteamento e o envio. | Capturada no `catch` do `process()`, logada, e respondida ao usuario com "Nao consegui processar sua mensagem." Falhar em silencio aqui seria indistinguivel do bot ignorando o usuario, o que esconderia bugs de pipeline indefinidamente. |
| EC-03: Conversa nova sem historico | Primeira mensagem de um usuario sem conversationId ativo. | Controller cria nova conversation via `MemoryManager.createConversation(userId)` e prossegue normalmente. |
| EC-04: Resultado do AgentLoop sem resposta textual | LLM retorna apenas tool calls sem texto final. | Controller usa `AgentLoopResult.finalResponse` que e sempre populado pelo loop (seja resposta do LLM ou mensagem de fallback). |

---

## 12. Seguranca e Privacidade

- **Isolamento de contexto:** Cada `conversationId` e isolado. O Controller nunca cruza mensagens de conversas diferentes.
- **Propagacao de erros segura:** Mensagens de erro enviadas ao usuario nunca contem dados internos (paths, API keys, stack traces). Apenas mensagens amigaveis.
- **Log seguro:** o Controller nunca loga conteudo de mensagem - apenas `source`, `conversationId`, nome da skill e `delivered`. O unico ponto do pipeline que pode emitir conteudo e o log de argumentos de tool do AgentLoop, controlado por `LOG_MESSAGE_CONTENT` (ver `agent-loop.md` 8.8).

---

## 13. Plano de Rollout

Entregue: pipeline completo, fila por conversa com teto e deteccao de stall, bloqueio de usuario por
evento, `resetConversation()` para `/novo`, shutdown aguardando mensagens em voo, e registro de
`delivered`. Coberto por `tests/controller-queue.test.ts`.

Em aberto: nenhum item de rollout. Ver 6.3 Fluxo C para a consequencia conhecida do shutdown.

---

## 14. Open Questions

- Q1 (Resolvida): Atualizacao manual com revisao de changelog. Semver automatico NAO sera usado no MVP - risco de breaking changes em dependencias core (grammy, sql.js) e alto demais para atualizacao desacompanhada. Dependabot/Renovate podem ser configurados para alertas apenas (nao PR automaticos) na versao 2.
- Q2 (Deferido para quando ocorrer): Mudancas na API de polling do Telegram sao abstraidas pelo Grammy. Se a API mudar de forma que o Grammy nao acompanhe, o contrato `ProcessedInput` pode precisar de adaptacao. Este risco e mitigado pelo fato de que o Grammy e mantido ativamente e a API de Bot do Telegram e estavel desde 2015. Nenhuma acao necessaria no MVP.
