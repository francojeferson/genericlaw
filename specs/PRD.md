# Spec: PRD — GeneriClaw Core

---

## 1. Resumo

O GeneriClaw é um agente pessoal de Inteligência Artificial para operar 100% localmente no desktop do usuário. Ele recebe comandos exclusivamente pelo Telegram, processa-os através de um pipeline que suporta múltiplos LLMs dinamicamente, e tem acesso persistente à memória em SQLite.

---

## 2. Contexto e Motivação

**Problema:**
Agentes hospedados na nuvem e serviços de terceiros requerem expor dados privados ou têm custos recorrentes altos, além da falta de total governança sobre as próprias "skills" customizadas. O usuário não tem controle pleno de instâncias como o OpenClaw sem esbarrar na complexidade da nuvem ou lock-in.

**Evidências:**
Tentativas anteriores baseadas no OpenClaw funcionavam, mas a intenção primária agora é manter uma base minimalista sob controle total do usuário, operando no próprio SO.

**Por que agora:**
A ascensão de LLMs super eficientes (Gemini 1.5/2.0+ e DeepSeek) somada com a facilidade da API do Telegram permitem rodar um agente pessoal sem os atritos operacionais de UI na web.

---

## 3. Goals (Objetivos)

- [ ] G-01: Operar primariamente recebendo e respondendo requisições pelo Telegram via `grammy`.
- [ ] G-02: Intercambiar "cérebros" (LLMs) usando padronização (DeepSeek, Gemini).
- [ ] G-03: Reter contexto por múltiplos turnos com SQLite via repositórios TS.
- [ ] G-04: Respeitar limites rigorosos de autorização via user ID (whitelist).

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Uptime local da API de bot (G-01) | 0% | 99% após testes | 30 dias |
| Latencia de switch de provider LLM (G-02) | N/A | < 500ms para fallback em execução | 30 dias |
| Taxa de sucesso de fallback entre providers (G-02) | N/A | > 95% das tentativas | 30 dias |
| Latencia de persistencia de mensagem (G-03) | N/A | < 10ms por insert (ver memory-manager.md seção 7) | 30 dias |
| Precisao da janela de contexto (G-03) | N/A | 100% das mensagens dentro do window carregadas | 30 dias |
| Requisicoes nao autorizadas bloqueadas por dia (G-04) | N/A | 100% bloqueadas, 0 falsos positivos | 30 dias |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Não terá interface Web (React/Vue/HTML). A interface é unicamente o Telegram.
- NG-02: Não suportará múltiplos usuários além da Whitelist estrita. Não é SaaS.
- NG-03: Suporte a bancos de dados robustos como PostgreSQL/Mongo. Foco exclusivo em SQLite local mínimo.

---

## 5. Usuários e Personas

**Usuário primário:** Generic (proprietário), acessando via dispositivo móvel ou desktop via cliente Telegram, utilizando IDs em whitelist restrita.

**Jornada atual (sem a feature):**
O usuário tem que gerir manualmente as APIs ou logar em múltiplas abas web (ChatGPT, Gemini) para acionar "skills" em blocos de texto independentes sem integrações de arquivos no próprio SO local.

**Jornada futura (com a feature):**
O usuário envia um chat no Telegram, o GeneriClaw roda local em background num terminal, chama LLMs, lê Skills em pastas locais, aciona ferramentas e responde no mesmo chat de forma orgânica.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O sistema deve rodar via loop de polling persistente da biblioteca Grammy | Must | O terminal aciona o listener com `npm run dev` e intercepta as mensagens sem fechar. |
| RF-02 | O sistema deve validar todas as mensagens entrantes contra a variável de `TELEGRAM_ALLOWED_USER_IDS` | Must | Um usuário não cadastrado recebe ignore instantâneo; nenhum log sensível é disparado e nenhuma API key é torrada. |
| RF-03 | O sistema deve alternar "LLMs" instanciando fábricas (`ProviderFactory`) com fallback automático | Must | Configurar `LLM_PROVIDER` (primário) e `LLM_PROVIDERS` (cadeia ordenada de fallback, ex: `gemini,deepseek`) no `.env`. Se o primário falhar, o próximo da cadeia é acionado automaticamente via `ProviderFactory.createWithFallback()`. Ver configuration.md e llm-provider.md para detalhes. |

### 6.2 Fluxo Principal (Happy Path)

1. O usuário manda uma string "resuma para mim" no Telegram.
2. O sistema do bot no PC intercepta (via Facade do `AgentController`).
3. O sistema checa se ID pertence à Whitelist (SIM).
4. O AgentController chama `SkillRouter.route(content, availableSkills)` para determinar skill ativa (chamada LLM adicional — cada mensagem incorre em DUAS chamadas LLM: roteamento + AgentLoop). A latência e custo dobrados são um tradeoff documentado do MVP. Com precos atuais de API (~$0.15/1M tokens input, ~$0.60/1M tokens output para Gemini 2.0 Flash), o custo adicional de roteamento e estimado em aproximadamente $0.05 por 1000 mensagens. SkillRouter usa o mesmo provider configurado via `ProviderFactory.createWithFallback()`. Ver skill-user.md seção 15 Q4.
5. O AgentController carrega o histórico do banco SQLite via MemoryManager, monta o array completo de mensagens (system prompt + histórico + input atual), e injeta no AgentLoop. O AgentLoop recebe o array pronto e nao consulta o banco de dados (ver agent-loop.md 6.2 step 2 e agent-controller.md 6.2.1 para o fluxo detalhado de montagem).
6. O LLM selecionado processa, encontra ou não a Tool necessária.
7. A resposta volta via Output Handler no chat Telegram.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A — Falha de API de LLM:**
1. LLM primário (ex: gemini) sobrecarregado (503).
2. O AgentLoop tenta fallback para outro config ou falha graciosamente enviando aviso pro Telegram em vez de quebrar a Promise da main engine.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Latência de repassagem de Msg | < 1000ms | Não confunde atraso do bot com o da API do provedor LLM. |
| RNF-02 | Persistência Ágil | SQlite Síncrono | `better-sqlite3` escolhido pela performance e simplicidade em single thread Node.js |

---

## 8. Design e Interface

**Componentes afetados:** Terminal log-output, e Chats do aplicativo Telegram do usuário Whitelisted.

**Estados da UI (No Telegram):**
- Estado de processamento: O bot sinaliza ação de digitação contínua via Chat Action do telegram até a requisição real de envio ser efetuada.

---

## 9. Modelo de Dados

O schema completo do banco de dados SQLite está definido em `memory.md` seção 9 — este é o source of truth autoritativo para a estrutura das tabelas `conversations` e `messages`. A PRD referencia o schema mas não o duplica.

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| Telegram API | Obrigatória | O agente se tornará inutilizável / Modo sleep no Node. |
| APIs (Gemini/DeepSeek) | Obrigatória | Sem raciocínio lógico. Precisará tentar fallback no `ProviderFactory`. |
| pacote `Grammy` | Obrigatória | Lib node core da arquitetura de polling |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Injeção por Usuário Falso | Receber requests de bots/crawlers | Cortar no Top-Level Middleware sem chegar ao DB. |
| EC-02: Banco de dados bloqueado | Dois loops simultâneos tentam escrita intensa | Espera via timeout natural do driver WAL (Write Ahead Logic), senão descarta soft e avisa LLM. |
| EC-03: Key Inválida | O arquivo `.env` tá corrompido ou API key descontinuada | Agent tenta inciar, loga Erro fatal de auth no Terminal e notifica no log que o provider `X` falhou. |
| EC-04: Excesso de processamento CPU | Arquivos imensos mandados para summary/pdf local | Trava por threshold e diz "Esse arquivo excede limites locais suportados." |

---

## 12. Segurança e Privacidade

- **Autenticação:** Baseada exclusivamente no Telegram User ID fornecido no array `.env` (`TELEGRAM_ALLOWED_USER_IDS`).
- **Autorização:** Aquele userId = Admin, os demais = rejeitados.

---

## 13. Estratégia de Testes

Todo módulo com contrato de interface (AgentController, AgentLoop, ProviderFactory, ToolRegistry, MemoryManager, SkillLoader, TelegramOutputHandler) deve ter testes unitários cobrindo o caminho feliz e os edge cases documentados.

- **Testes unitários:** Vitest + mocks manuais. Cada módulo testado isoladamente com dependências mockadas.
- **AgentLoop com LLM mockado:** `ILlmProvider` mock que retorna respostas pré-definidas (tool calls, erros, JSON malformado) para validar cada edge case do loop sem depender de API externa.
- **MemoryManager:** SQLite em memória (`:memory:`) para testes de persistência sem arquivo real.
- **Cobertura mínima alvo:** 80% de branches nos módulos core (AgentLoop, AgentController, ProviderFactory).
- **Integração:** Teste ponta a ponta com Telegram mockado (grammy `Context` falso) para validar o pipeline completo input -> controller -> loop -> output.

### Estrutura de arquivos de teste

```
tests/
  unit/
    agent-loop.test.ts
    agent-controller.test.ts
    provider-factory.test.ts
    tool-registry.test.ts
    memory-manager.test.ts
    skill-loader.test.ts
    skill-router.test.ts
    config.test.ts
  integration/
    pipeline.test.ts        # input -> controller -> loop -> output com mocks
  mocks/
    llm-provider.mock.ts    # Mock de ILlmProvider
    memory-manager.mock.ts  # Mock de MemoryManager
    grammy-context.mock.ts  # Mock de Grammy Context
```

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
  private blockedConversations: Set<string>;

  async initialize(): Promise<void>;
  createConversation(userId: string, provider?: string): Conversation;
  getRecentMessages(conversationId: string): Message[];
  saveResponse(conversationId: string, result: AgentLoopResult): void;
  isConversationBlocked(conversationId: string): boolean;
  markConversationBlocked(conversationId: string): void;
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

- **Estratégia:** Deploy em máquina local rodando `npm run dev` para a instância primaria.
- **Monitoramento:** Log no Stdout no terminal para acompanhar transições de Agent Loop e falhas nas Requests.

---

## 15. Open Questions

- Q1 (Resolvida): Atualizacao manual com revisao de changelog. Semver automatico NAO sera usado no MVP — risco de breaking changes em dependencias core (grammy, better-sqlite3) e alto demais para atualizacao desacompanhada. Dependabot/Renovate podem ser configurados para alertas apenas (nao PR automaticos) na versao 2. Alinhado com agent-controller.md Q1.
- Q2 (Deferido para v2): "Uptime local 99%". A métrica precisa de definição operacional (processo Node? polling? pipeline completo incluindo LLM?). Para MVP, uptime é monitorado informalmente via logs de stdout. Definição formal e alertas serão implementados na versão 2.
- Q3 (Resolvido): O conceito de Skill é definido em `skill-user.md` (seção 12 - Fronteira Skill vs Tool). PRD faz referência via métrica G-04. Cross-reference explícita adicionada: ver `specs/skill-user.md`.
