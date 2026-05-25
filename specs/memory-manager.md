# Spec: MemoryManager (Facade de Persistencia)

---

## 1. Resumo

O `MemoryManager` e o facade central da camada de persistencia do GeneriClaw. Ele expoe uma interface unificada para inicializacao do banco, gerenciamento de conversas, persistencia de mensagens, controle de janela de contexto, truncamento, e bloqueio de usuarios. Nenhum outro modulo acessa `ConversationRepository` ou `MessageRepository` diretamente — toda operacao de persistencia passa pelo facade.

---

## 2. Contexto e Motivacao

**Problema:**
architecture.md posiciona `MemoryManager` como Facade na camada de persistencia. agent-controller.md e bootstrap.md referenciam metodos como `initialize()`, `getRecentMessages()`, `saveResponse()`, `createConversation()`, `markConversationBlocked()`, `isConversationBlocked()`. Mas nenhum spec define o contrato completo da classe. Sem ele, cada modulo acopla diretamente aos repositorios, quebrando o padrao Facade.

**Evidencias:**
O padrao Facade e listado em architecture.md secao 7 como um dos design patterns utilizados. Os repositorios (`ConversationRepository`, `MessageRepository`) sao detalhados em memory.md secao 5, mas o facade que os agrupa nao tem contrato documentado.

**Por que agora:**
Sem o contrato do MemoryManager, os desenvolvedores nao sabem quais metodos chamar. Alguns acoplarao direto aos repositorios, outros criarao seus proprios wrappers. O facade fecha o gap e garante coesao.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir todos os metodos publicos do `MemoryManager` referenciados por outros specs.
- [ ] G-02: Delegar operacoes aos repositorios internos (`ConversationRepository`, `MessageRepository`) sem expo-los.
- [ ] G-03: Centralizar logica de truncamento de mensagens (janela de contexto) e limpeza de conversas antigas.
- [ ] G-04: Gerenciar ciclo de vida da conexao SQLite (inicializar, fechar).

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Modulos que acessam repositorios diretamente | N | 0 | MVP |
| Metodos do facade nao implementados | N/A | 0 | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: MemoryManager nao implementa SQL diretamente. SQL e responsabilidade dos repositorios.
- NG-02: MemoryManager nao gerencia schema migrations. Isso e feito pelo Singleton de DB na inicializacao (ver memory.md secao 9).
- NG-03: MemoryManager nao gerencia tokens nem calcula custos. Isso e responsabilidade do AgentLoop e ProviderFactory.

---

## 5. Usuarios e Personas

**Usuarios primarios:**
- `AgentController`: persiste mensagens, cria conversas, carrega historico, gerencia bloqueios.
- `Bootstrap`: inicializa e fecha a conexao com o banco.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `initialize()` deve criar conexao SQLite, executar PRAGMAs, criar tabelas se nao existirem. | Must | Chamar `initialize()` cria arquivo `db.sqlite` com schema correto. |
| RF-02 | `createConversation(userId, provider)` deve criar nova conversa e retornar o objeto `Conversation`. | Must | Conversa aparece em `findByUserId()`. |
| RF-03 | `getRecentMessages(conversationId)` deve retornar as ultimas `MEMORY_WINDOW_SIZE` mensagens da conversa. | Must | Retorna array com no maximo `MEMORY_WINDOW_SIZE` mensagens, ordenadas por `created_at` ascendente. |
| RF-04 | `saveMessage(conversationId, role, content, metadata?)` deve persistir mensagem e disparar truncamento se necessario. | Must | Mensagem aparece em `getRecentMessages()`. Se `COUNT > MEMORY_WINDOW_SIZE * 4`, mensagens antigas sao truncadas. |
| RF-05 | `saveResponse(conversationId, result)` deve persistir a resposta final do AgentLoop. | Must | Resposta aparece no historico. Conteudo acima de 64KB e truncado antes da insercao. |
| RF-06 | `markConversationBlocked(conversationId)` deve setar `blocked = 1` na conversa. | Must | `isConversationBlocked()` retorna `true` apos chamada. |
| RF-07 | `isConversationBlocked(conversationId)` deve retornar `true` se a conversa esta bloqueada. | Must | Usado pelo AgentController para descartar mensagens de usuarios bloqueados. |
| RF-08 | `shutdown()` deve fechar a conexao SQLite graciosamente. | Must | Chamado durante `AgentController.shutdown()`. Nao corrompe o banco. |
| RF-09 | `truncateOldMessages(conversationId)` deve manter apenas `MEMORY_WINDOW_SIZE` mensagens mais recentes. | Must | Chamado automaticamente apos cada insercao se `COUNT > MEMORY_WINDOW_SIZE * 4`. |
| RF-10 | `updateConversationTitle(conversationId, title)` deve atualizar o titulo da conversa. | Should | Usado para derivar titulo da primeira mensagem do usuario. |

### 6.2 Fluxo Principal (Happy Path)

1. Bootstrap chama `MemoryManager.initialize()`. Conexao SQLite e criada, PRAGMAs executados, tabelas criadas.
2. Usuario envia primeira mensagem. AgentController chama `createConversation(userId, 'gemini')`. Retorna `Conversation` com UUID gerado.
3. AgentController chama `saveMessage(conversationId, 'user', 'Oi agente')`.
4. AgentController chama `getRecentMessages(conversationId)`. Retorna array com a mensagem recem-persistida.
5. Apos AgentLoop retornar `AgentLoopResult`, AgentController chama `saveResponse(conversationId, result)`.
6. `saveResponse` persiste `role='assistant'` com o conteudo da resposta. Se conteudo > 64KB, trunca.
7. `saveResponse` verifica `COUNT(messages) > MEMORY_WINDOW_SIZE * 4`. Se sim, chama `truncateOldMessages()`.
8. No shutdown, AgentController chama `MemoryManager.shutdown()`. Conexao SQLite fechada.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A — Usuario bloqueado:**
1. OutputHandler detecta erro 403 "Forbidden" ao enviar resposta.
2. OutputHandler emite evento `userBlocked`.
3. AgentController captura e chama `MemoryManager.markConversationBlocked(conversationId)`.
4. Proxima mensagem do usuario: AgentController chama `isConversationBlocked(conversationId)` → `true`. Processamento descartado.

**Fluxo Alternativo B — Truncamento de mensagem longa:**
1. `saveResponse` recebe conteudo de 80KB.
2. `MemoryManager` trunca para 65536 bytes (UTF-8).
3. Loga warning: `[MemoryManager] Message content truncated from 81920 to 65536 bytes.`
4. Conteudo truncado e persistido.

---

## 7. Requisitos Nao-Funcionais

Ver memory.md seção 7 para os requisitos não-funcionais de persistência. MemoryManager herda os mesmos SLAs via delegação aos repositórios.

---

## 8. Design e Interface

### 8.1 Conversation

```typescript
interface Conversation {
  id: string;
  userId: string;
  title: string;
  provider: string;
  blocked: number;
  createdAt: string;
  updatedAt: string;
}
```

### 8.2 Message

```typescript
interface Message {
  id: number;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
  metadata: string;  // JSON string
  createdAt: string;
}
```

### 8.3 MemoryManager

```typescript
class MemoryManager {
  private db: Database;
  private conversationRepo: ConversationRepository;
  private messageRepo: MessageRepository;
  private insertCounter: number;

  constructor(config: { dbPath: string; windowSize: number; dbMaxSizeMb: number });

  // Ciclo de vida
  async initialize(): Promise<void>;
  async shutdown(): Promise<void>;

  // Conversas
  createConversation(userId: string, provider?: string): Conversation;
  getConversation(conversationId: string): Conversation | null;
  getConversationsByUser(userId: string): Conversation[];
  updateConversationTitle(conversationId: string, title: string): void;

  // Mensagens
  saveMessage(
    conversationId: string,
    role: "user" | "assistant" | "system" | "tool",
    content: string,
    toolName?: string,
    toolCallId?: string,
    metadata?: string
  ): Message;
  saveResponse(conversationId: string, result: AgentLoopResult): void;
  getRecentMessages(conversationId: string): Message[];

  // Bloqueio de usuario
  markConversationBlocked(conversationId: string): void;
  isConversationBlocked(conversationId: string): boolean;

  // Manutencao
  truncateOldMessages(conversationId: string): number;
}
```

### 8.4 Database Singleton

A conexao SQLite e gerenciada como Singleton para garantir uma unica instancia de `better-sqlite3.Database` em todo o processo. O Singleton e encapsulado dentro do `MemoryManager` — a instancia de `Database` e criada em `initialize()` e fechada em `shutdown()`. Nenhum outro modulo acessa `new Database(...)` diretamente.

```typescript
// Padrao: Singleton via lazy initialization gerenciada pelo facade
class MemoryManager {
  private static dbInstance: Database | null = null;

  async initialize(): Promise<void> {
    if (MemoryManager.dbInstance) {
      // Reutiliza conexao existente
      this.db = MemoryManager.dbInstance;
      return;
    }
    this.db = new Database(config.dbPath, { /* WAL, etc */ });
    MemoryManager.dbInstance = this.db;
    // ... schema migration, PRAGMA config ...
  }

  async shutdown(): Promise<void> {
    if (this.conversationRepo) this.conversationRepo = undefined;
    if (this.messageRepo) this.messageRepo = undefined;
    if (this.db) {
      this.db.close();
      MemoryManager.dbInstance = null;
    }
  }
}
```

**Contrato:**
- `dbInstance` e estatica e privada. Apenas `MemoryManager` gerencia seu ciclo de vida.
- `initialize()` e idempotente — chamadas repetidas reutilizam a conexao existente.
- `shutdown()` fecha a conexao e zera `dbInstance`. Apos shutdown, uma nova chamada a `initialize()` cria uma nova conexao.
- O padrao Singleton garante que `ConversationRepository` e `MessageRepository` (instanciados internamente pelo facade) compartilhem a mesma conexao sem necessidade de injecao explicita.

---

## 9. Modelo de Dados

MemoryManager nao define schema proprio. O schema SQLite esta documentado em `memory.md` secao 9 (source of truth). MemoryManager opera sobre as tabelas `conversations` e `messages` via repositorios.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| `better-sqlite3` | Obrigatoria | Sem driver, initialize() falha. |
| `ConversationRepository` | Interna | Operacoes de conversa delegadas a este repositorio. |
| `MessageRepository` | Interna | Operacoes de mensagem delegadas a este repositorio. |
| Filesystem (`fs`) | Obrigatoria | DB path deve ser acessivel. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: DB nao inicializado | Chamada a qualquer metodo antes de `initialize()`. | Lanca erro: `"MemoryManager not initialized. Call initialize() first."` |
| EC-02: Conversa inexistente | `getConversation()` ou `getRecentMessages()` com ID invalido. | Retorna `null` ou array vazio. Nao lanca excecao. |
| EC-03: Conteudo com null bytes | Mensagem contem `\u0000`. | `saveMessage()` aplica `content.replace(/\u0000/g, '')` antes de inserir. |
| EC-04: Conteudo excede 64KB | Resposta do LLM > 65536 bytes. | Truncado para 65536 bytes (UTF-8) antes da insercao. Warning logado. |
| EC-05: Vacuum periodico | Contador de insercoes atinge 500. | `PRAGMA incremental_vacuum` executado. Contador resetado. |
| EC-06: DB excede tamanho maximo | Arquivo `.db` > `DB_MAX_SIZE_MB` na inicializacao. | `VACUUM` completo executado. Warning logado. |
| EC-07: Operacao apos shutdown | Chamada a qualquer metodo publico apos `shutdown()`. | Lanca erro: `"MemoryManager is shut down."` Um flag interno `isShutdown` controla isso — setado como `true` no inicio de `shutdown()` e verificado no inicio de cada metodo publico. Este guard previne comportamento indefinido durante race conditions entre shutdown e mensagens em voo. |
---

## 12. Seguranca e Privacidade

- **DB path:** Configurado via `DB_PATH`. Arquivo nunca commitado no Git.
- **Sem logs de conteudo:** MemoryManager nao loga conteudo de mensagens. Apenas metadados (ID, role, tamanho).
- **Truncamento seguro:** Conteudo truncado preserva integridade UTF-8 — nao corta no meio de um caractere multi-byte.

---

## 13. Plano de Rollout

1. Implementar `MemoryManager` com `initialize()` e `shutdown()`.
2. Adicionar `createConversation()` e `saveMessage()`.
3. Adicionar `getRecentMessages()` com `MEMORY_WINDOW_SIZE`.
4. Adicionar `saveResponse()` com truncamento de 64KB.
5. Adicionar `markConversationBlocked()` e `isConversationBlocked()`.
6. Adicionar `truncateOldMessages()` e vacuum periodico.

---

## 14. Open Questions

(Nenhuma no momento — este spec foi criado para resolver o gap critico de documentacao.)
