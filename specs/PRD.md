# Spec: PRD - GeneriClaw Core

---

## 1. Resumo

O GeneriClaw e um agente pessoal de Inteligencia Artificial para operar 100% localmente no desktop do usuario. Ele recebe comandos exclusivamente pelo Telegram, processa-os atraves de um pipeline que suporta multiplos LLMs dinamicamente, e tem acesso persistente a memoria em SQLite.

---

## 2. Contexto e Motivacao

**Problema:**
Agentes hospedados na nuvem e servicos de terceiros requerem expor dados privados ou tem custos recorrentes altos, alem da falta de total governanca sobre as proprias "skills" customizadas. O usuario nao tem controle pleno de instancias como o OpenClaw sem esbarrar na complexidade da nuvem ou lock-in.

**Evidencias:**
Tentativas anteriores baseadas no OpenClaw funcionavam, mas a intencao primaria agora e manter uma base minimalista sob controle total do usuario, operando no proprio SO.

**Por que agora:**
A ascensao de LLMs super eficientes (Gemini 1.5/2.0+ e DeepSeek) somada com a facilidade da API do Telegram permitem rodar um agente pessoal sem os atritos operacionais de UI na web.

---

## 3. Goals (Objetivos)

- [ ] G-01: Operar primariamente recebendo e respondendo requisicoes pelo Telegram via `grammy`.
- [ ] G-02: Intercambiar "cerebros" (LLMs) usando padronizacao (DeepSeek, Gemini).
- [ ] G-03: Reter contexto por multiplos turnos com SQLite via repositorios TS.
- [ ] G-04: Respeitar limites rigorosos de autorizacao via user ID (whitelist).

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Uptime local da API de bot (G-01) | 0% | 99% apos testes | 30 dias |
| Latencia de switch de provider LLM (G-02) | N/A | < 500ms para fallback em execucao | 30 dias |
| Taxa de sucesso de fallback entre providers (G-02) | N/A | > 95% das tentativas | 30 dias |
| Latencia de persistencia de mensagem (G-03) | N/A | < 10ms por insert (ver memory-manager.md secao 7) | 30 dias |
| Precisao da janela de contexto (G-03) | N/A | 100% das mensagens dentro do window carregadas | 30 dias |
| Requisicoes nao autorizadas bloqueadas por dia (G-04) | N/A | 100% bloqueadas, 0 falsos positivos | 30 dias |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Nao tera interface Web (React/Vue/HTML). A interface e unicamente o Telegram.
- NG-02: Nao suportara multiplos usuarios alem da Whitelist estrita. Nao e SaaS.
- NG-03: Suporte a bancos de dados robustos como PostgreSQL/Mongo. Foco exclusivo em SQLite local minimo.

---

## 5. Usuarios e Personas

**Usuario primario:** Generic (proprietario), acessando via dispositivo movel ou desktop via cliente Telegram, utilizando IDs em whitelist restrita.

**Jornada atual (sem a feature):**
O usuario tem que gerir manualmente as APIs ou logar em multiplas abas web (ChatGPT, Gemini) para acionar "skills" em blocos de texto independentes sem integracoes de arquivos no proprio SO local.

**Jornada futura (com a feature):**
O usuario envia um chat no Telegram, o GeneriClaw roda local em background num terminal, chama LLMs, le Skills em pastas locais, aciona ferramentas e responde no mesmo chat de forma organica.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O sistema deve rodar via loop de polling persistente da biblioteca Grammy | Must | O terminal aciona o listener com `npm run dev` e intercepta as mensagens sem fechar. |
| RF-02 | O sistema deve validar todas as mensagens entrantes contra a variavel de `TELEGRAM_ALLOWED_USER_IDS` | Must | Um usuario nao cadastrado recebe ignore instantaneo; nenhum log sensivel e disparado e nenhuma API key e torrada. |
| RF-03 | O sistema deve alternar "LLMs" instanciando fabricas (`ProviderFactory`) com fallback automatico | Must | Configurar `LLM_PROVIDER` (primario) e `LLM_PROVIDERS` (cadeia ordenada de fallback, ex: `gemini,deepseek`) no `.env`. Se o primario falhar, o proximo da cadeia e acionado automaticamente via `ProviderFactory.createWithFallback()`. Ver configuration.md e llm-provider.md para detalhes. |

### 6.2 Fluxo Principal (Happy Path)

1. O usuario manda uma string "resuma para mim" no Telegram.
2. O sistema do bot no PC intercepta (via Facade do `AgentController`).
3. O sistema checa se ID pertence a Whitelist (SIM).
4. O AgentController chama `SkillRouter.route(content, availableSkills)` para determinar skill ativa (chamada LLM adicional - cada mensagem incorre em DUAS chamadas LLM: roteamento + AgentLoop). A latencia e custo dobrados sao um tradeoff documentado do MVP. Com precos atuais de API (~$0.15/1M tokens input, ~$0.60/1M tokens output para Gemini 2.0 Flash), o custo adicional de roteamento e estimado em aproximadamente $0.05 por 1000 mensagens. SkillRouter usa o mesmo provider configurado via `ProviderFactory.createWithFallback()`. Ver skill-user.md secao 15 Q4.
5. O AgentController carrega o historico do banco SQLite via MemoryManager, monta o array completo de mensagens (system prompt + historico + input atual), e injeta no AgentLoop. O AgentLoop recebe o array pronto e nao consulta o banco de dados (ver agent-loop.md 6.2 step 2 e agent-controller.md 6.2.1 para o fluxo detalhado de montagem).
6. O LLM selecionado processa, encontra ou nao a Tool necessaria.
7. A resposta volta via Output Handler no chat Telegram.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A - Falha de API de LLM:**
1. LLM primario (ex: gemini) sobrecarregado (503).
2. O AgentLoop tenta fallback para outro config ou falha graciosamente enviando aviso pro Telegram em vez de quebrar a Promise da main engine.

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Latencia de repassagem de Msg | < 1000ms | Nao confunde atraso do bot com o da API do provedor LLM. |
| RNF-02 | Persistencia Agil | SQlite Sincrono | `sql.js` (SQLite em wasm): API sincrona, sem dependencia nativa para compilar. Persiste exportando o banco inteiro, o que exige a flag de sujeira descrita em memory-manager.md 8.5 |

---

## 8. Design e Interface

**Componentes afetados:** Terminal log-output, e Chats do aplicativo Telegram do usuario Whitelisted.

**Estados da UI (No Telegram):**
- Estado de processamento: O bot sinaliza acao de digitacao continua via Chat Action do telegram ate a requisicao real de envio ser efetuada.

---

## 9. Modelo de Dados

O schema completo do banco de dados SQLite esta definido em `memory.md` secao 9 - este e o source of truth autoritativo para a estrutura das tabelas `conversations` e `messages`. A PRD referencia o schema mas nao o duplica.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| Telegram API | Obrigatoria | O agente se tornara inutilizavel / Modo sleep no Node. |
| APIs (Gemini/DeepSeek) | Obrigatoria | Sem raciocinio logico. Precisara tentar fallback no `ProviderFactory`. |
| pacote `Grammy` | Obrigatoria | Lib node core da arquitetura de polling |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Injecao por Usuario Falso | Receber requests de bots/crawlers | Cortar no Top-Level Middleware sem chegar ao DB. |
| EC-02: Escrita concorrente no banco | Dois turnos simultaneos escrevem no mesmo banco | O `sql.js` opera em memoria num unico processo e o AgentController serializa o processamento por conversa, entao nao ha contencao de arquivo. A persistencia e uma reescrita completa do arquivo, controlada pela flag de sujeira (ver memory-manager.md 8.5). |
| EC-03: Key Invalida | O arquivo `.env` ta corrompido ou API key descontinuada | Agent tenta inciar, loga Erro fatal de auth no Terminal e notifica no log que o provider `X` falhou. |
| EC-04: Excesso de processamento CPU | Arquivos imensos mandados para summary/pdf local | Trava por threshold e diz "Esse arquivo excede limites locais suportados." |

---

## 12. Seguranca e Privacidade

- **Autenticacao:** Baseada exclusivamente no Telegram User ID fornecido no array `.env` (`TELEGRAM_ALLOWED_USER_IDS`).
- **Autorizacao:** Aquele userId = Admin, os demais = rejeitados.

---

## 13. Estrategia de Testes

Todo modulo com contrato de interface (AgentController, AgentLoop, ProviderFactory, ToolRegistry, MemoryManager, SkillLoader, TelegramOutputHandler) deve ter testes unitarios cobrindo o caminho feliz e os edge cases documentados.

- **Testes unitarios:** Vitest + mocks manuais. Cada modulo testado isoladamente com dependencias mockadas.
- **AgentLoop com LLM mockado:** `ILlmProvider` mock que retorna respostas pre-definidas (tool calls, erros, JSON malformado) para validar cada edge case do loop sem depender de API externa.
- **MemoryManager:** SQLite em memoria (`:memory:`) para testes de persistencia sem arquivo real.
- **Cobertura minima alvo:** 80% de branches nos modulos core (AgentLoop, AgentController, ProviderFactory).
- **Integracao:** Teste ponta a ponta com Telegram mockado (grammy `Context` falso) para validar o pipeline completo input -> controller -> loop -> output.

### Estrutura de arquivos de teste

Suite atual (`npx vitest run`), organizada por comportamento e nao por classe:

```
tests/
  agent-loop.test.ts            # deduplicacao de tool calls, soma de tokens,
                                # teto e paginacao de ler_arquivo (ScriptedProvider local)
  provider-request-body.test.ts # o corpo JSON que sai para cada provider: par tool_calls/tool;
                                # retryCount 0 do gemini nao vira 3
  log-privacy.test.ts           # LOG_MESSAGE_CONTENT desligado nao deixa conteudo no log
  memory.test.ts                # id da conversa, ordenacao, truncamento, /novo,
                                # persistencia de schema e de dados no shutdown,
                                # gravacao por rename, recuperacao de banco corrompido
  memory-window.test.ts         # janela, limite zero, minimos de config, tamanho do banco
  config.test.ts                # chaves ausentes/invalidas, defaults, regras de provider
  bootstrap-providers.test.ts   # boot real: provider inutilizavel mata o processo; diretorios
  controller-queue.test.ts      # fila por conversa, timers cancelados, registro de delivered
  skill-loader.test.ts          # frontmatter, defaults, regras de skip, dedupe, reload
  workspace-path.test.ts        # contencao de path, overwrite, validateArgs
  upload-path.test.ts           # nome seguro de upload, contencao contra file_name hostil
  upload-collision.test.ts      # dois envios de mesmo nome, corrida no diretorio temporario,
                                # gate de acesso (so o dono em chat privado) e bot.catch
  audio-request.test.ts         # deteccao de pedido de audio no texto
  audio-output.test.ts          # fallback de TTS, chunking, InputFile, valor de Delivered
```

### O teste le o destino, nao a origem

Uma peca que **roda** nao e uma peca que **entrega**. Testes que exercitam a funcao e inspecionam o
objeto que ela devolve passam exatamente nos defeitos em que a saida nunca chega ao consumidor.
Antes de cada teste, escreva onde o consumidor le a saida, e verifique **la**:

| Peca | Destino que o teste le |
|---|---|
| Providers | o corpo JSON passado ao `fetch` |
| Estrategias de saida | o texto/arquivo que chegaria em `ctx.reply`/`replyWithVoice` |
| Handler de documento | os arquivos no `WORKSPACE_ROOT` |
| Bootstrap | o stderr e o exit code de `npx tsx src/main.ts` de verdade |
| Log de privacidade | o que `console.*` recebeu |
| Fila do controller | timers pendentes e o `metadata` gravado |

**Marcador plantado, com controle.** Faca uma string unica percorrer o caminho real e procure-a no
destino. Se nao achar, descubra antes de concluir se a peca nao entrega ou se a **busca** esta
quebrada - plante um segundo marcador num campo que comprovadamente chega. Sem esse controle,
"nao achei" nao e prova de nada.

Isso nao e teoria: o marcador de controle ja derrubou duas conclusoes erradas nesta suite. Uma
investigacao sobre `MEMORY_WINDOW_SIZE=0` apontava "manda o historico inteiro ao LLM"; o teste
passou de primeira, e o efeito real era o oposto e pior - o historico era **apagado** a cada
mensagem. E o primeiro teste da fila do controller usava `shutdown()` para esperar, sem notar que
ele descarta as respostas em voo.

**O que ainda nao tem teste:** o caminho de voz de ponta a ponta (whisper e edge-tts sao binarios
externos) e o Gemini contra a API real. A verificacao desses vem de execucao real contra o bot,
lendo o `metadata` da mensagem no banco - `delivered: "voice"` prova que o audio saiu.

### Testes de regressao devem falhar contra o bug

Um teste de regressao que passa tanto na versao corrigida quanto na versao com o bug nao testa
nada. Antes de considerar um teste de regressao pronto, reintroduza o defeito e confirme a falha.

Aplicado nesta suite: os testes de contencao de path, de persistencia no shutdown e de soma de
tokens falham contra o codigo antigo. O teste de ordenacao de mensagens **nao** falha - o SQLite
desempata `created_at` por rowid atraves do indice, entao o comportamento antigo tambem passava. Ele
permanece como teste de contrato e esta marcado como tal, em vez de alegar uma protecao que nao tem.

### Contratos de mock

**Mock ILlmProvider:**
```typescript
class MockLlmProvider implements ILlmProvider {
  readonly name = "mock";
  private responses: LlmResponse[];  // fila de respostas pre-definidas

  enqueueResponse(response: LlmResponse): void;
  async generate(messages: LlmMessage[]): Promise<LlmResponse>;
}
```

**Mock MemoryManager:**
```typescript
class MockMemoryManager {
  private conversations: Map<string, Conversation>;
  private messages: Map<string, Message[]>;

  async initialize(): Promise<void>;
  createConversation(userId: string, provider?: string): Conversation;
  getRecentMessages(conversationId: string): Message[];
  saveResponse(conversationId: string, result: AgentLoopResult): void;
}
```

**Mock Grammy Context:**
```typescript
class MockGrammyContext {
  readonly chat: { id: number };
  readonly from: { id: number; first_name: string };
  private sentMessages: string[];

  async reply(text: string): Promise<void>;
  async replyWithDocument(path: string): Promise<void>;
  async replyWithVoice(path: string): Promise<void>;
}
```

---

## 14. Plano de Rollout

- **Estrategia:** Deploy em maquina local rodando `npm run dev` para a instancia primaria.
- **Monitoramento:** Log no Stdout no terminal para acompanhar transicoes de Agent Loop e falhas nas Requests.

---

## 15. Open Questions

- Q1 (Resolvida): Atualizacao manual com revisao de changelog. Semver automatico NAO sera usado no MVP - risco de breaking changes em dependencias core (grammy, sql.js) e alto demais para atualizacao desacompanhada. Dependabot/Renovate podem ser configurados para alertas apenas (nao PR automaticos) na versao 2. Alinhado com agent-controller.md Q1.
- Q2 (Deferido para v2): "Uptime local 99%". A metrica precisa de definicao operacional (processo Node? polling? pipeline completo incluindo LLM?). Para MVP, uptime e monitorado informalmente via logs de stdout. Definicao formal e alertas serao implementados na versao 2.
- Q3 (Resolvido): O conceito de Skill e definido em `skill-user.md` (secao 12 - Fronteira Skill vs Tool). PRD faz referencia via metrica G-04. Cross-reference explicita adicionada: ver `specs/skill-user.md`.
