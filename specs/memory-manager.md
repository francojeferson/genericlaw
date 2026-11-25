# Spec: MemoryManager (Facade de Persistencia)

---

## 1. Resumo

O `MemoryManager` e o facade central da camada de persistencia do GeneriClaw. Ele expoe uma interface unificada para inicializacao do banco, gerenciamento de conversas, persistencia de mensagens, controle de janela de contexto, truncamento, e bloqueio de usuarios. Nenhum outro modulo acessa `ConversationRepository` ou `MessageRepository` diretamente - toda operacao de persistencia passa pelo facade.

---

## 2. Contexto e Motivacao

**Problema:**
architecture.md posiciona `MemoryManager` como Facade na camada de persistencia. agent-controller.md e bootstrap.md referenciam metodos como `initialize()`, `getRecentMessages()`, `saveResponse()`, `createConversation()`. Mas nenhum spec define o contrato completo da classe. Sem ele, cada modulo acopla diretamente aos repositorios, quebrando o padrao Facade.

**Evidencias:**
O padrao Facade e listado em architecture.md secao 7 como um dos design patterns utilizados. Os repositorios (`ConversationRepository`, `MessageRepository`) sao detalhados em memory.md secao 5, mas o facade que os agrupa nao tem contrato documentado.

**Por que agora:**
Sem o contrato do MemoryManager, os desenvolvedores nao sabem quais metodos chamar. Alguns acoplarao direto aos repositorios, outros criarao seus proprios wrappers. O facade fecha o gap e garante coesao.

---

## 3. Goals (Objetivos)

- [x] G-01: Definir todos os metodos publicos do `MemoryManager` referenciados por outros specs.
- [x] G-02: Delegar operacoes aos repositorios internos (`ConversationRepository`, `MessageRepository`) sem expo-los.
- [x] G-03: Centralizar logica de truncamento de mensagens (janela de contexto) e limpeza de conversas antigas.
- [x] G-04: Gerenciar ciclo de vida da conexao SQLite (inicializar, fechar).
- [x] G-05: Registrar no `metadata` o que foi entregue ao usuario, nao apenas o que foi pedido.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Modulos que acessam repositorios diretamente | N | 0 | MVP |
| Metodos do facade nao implementados | N/A | 0 | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: MemoryManager nao implementa SQL diretamente. SQL e responsabilidade dos repositorios.
- NG-02: MemoryManager nao expoe migrations como API publica. `runMigrations()` e privado e roda uma vez em `initialize()`, junto com a criacao do Singleton de DB (ver memory.md secao 9 e 8.5 abaixo).
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
| RF-02 | `createConversation(userId, id?)` deve criar nova conversa e retornar o objeto `Conversation`. | Must | A conversa e localizavel por `getConversation(id)`. |
| RF-02b | `clearMessages(conversationId)` apaga o historico mantendo a linha da conversa, e retorna quantas mensagens removeu. | Must | Apos limpar, `getRecentMessages()` volta vazio e a proxima mensagem salva sem erro. |
| RF-03 | `getRecentMessages(conversationId)` deve retornar as ultimas `MEMORY_WINDOW_SIZE` mensagens da conversa. | Must | Retorna array com no maximo `MEMORY_WINDOW_SIZE` mensagens, ordenadas por `id` ascendente (ordem de insercao). |
| RF-04 | `saveMessage(conversationId, role, content, metadata?)` deve persistir mensagem e disparar truncamento se necessario. | Must | Mensagem aparece em `getRecentMessages()`. Se `COUNT > MEMORY_WINDOW_SIZE * 4`, mensagens antigas sao truncadas. |
| RF-05 | `saveResponse(conversationId, result, delivered?)` deve persistir a resposta final do AgentLoop. | Must | Resposta aparece no historico. Conteudo acima de 64KB e truncado antes da insercao. O `metadata` grava `usage`, `finishReason`, `toolCallsMade`, `iterationsUsed` e `delivered`. |
| RF-08 | `shutdown()` deve fechar a conexao SQLite graciosamente. | Must | Chamado durante `AgentController.shutdown()`. Nao corrompe o banco. |
| RF-09 | `truncateOldMessages(conversationId)` deve manter apenas `MEMORY_WINDOW_SIZE` mensagens mais recentes. | Must | Chamado automaticamente apos cada insercao se `COUNT > MEMORY_WINDOW_SIZE * 4`. |
| RF-10 | `getRecentMessages()` com `windowSize <= 0` deve devolver vazio, nunca a conversa inteira. | Must | `findByConversationId(id, 0)` retorna `[]`. O ramo "sem LIMIT" e reservado a chamadas sem o argumento. |

**Removidos:** `getConversationsByUser()` e `updateConversationTitle()` existiram no facade e nunca
tiveram chamador. Foram apagados junto com `findByUserId()`, `updateTitle()`, os campos
`Conversation.title`/`.provider` e o indice `idx_conversations_user_id` - que custava uma escrita a
cada mensagem salva, sem nenhuma consulta que o usasse. As colunas `title` e `provider` continuam no
`CREATE TABLE` de proposito: `CREATE TABLE IF NOT EXISTS` nao altera bancos ja existentes, entao
remove-las criaria dois formatos de schema em circulacao sem ganho algum.

`markConversationBlocked()` e `isConversationBlocked()` (antigos RF-06 e RF-07) tambem foram
removidos, junto com `markBlocked()`/`isBlocked()` nos repositorios: nada limpava o flag, entao um
bloqueio seguido de desbloqueio do bot trancava o dono para fora, em silencio. A coluna `blocked`
fica no `CREATE TABLE` e em `Conversation.blocked`, sem uso, pelo mesmo motivo de `title` e `provider`.

### 6.2 Fluxo Principal (Happy Path)

1. Bootstrap chama `MemoryManager.initialize()`. Conexao SQLite e criada, PRAGMAs executados, tabelas criadas.
2. Usuario envia primeira mensagem. AgentController chama `createConversation(userId, conversationId)` passando o id do chat do Telegram. Retorna a `Conversation` com esse id.
3. AgentController chama `saveMessage(conversationId, 'user', 'Oi agente')`.
4. AgentController chama `getRecentMessages(conversationId)`. Retorna array com a mensagem recem-persistida.
5. Apos o envio ao usuario, AgentController chama `saveResponse(conversationId, result, delivered)` - depois do envio porque `delivered` so existe entao (ver `agent-controller.md` 6.2).
6. `saveResponse` persiste `role='assistant'` com o conteudo da resposta. Se conteudo > 64KB, trunca.
7. `saveResponse` verifica `COUNT(messages) > MEMORY_WINDOW_SIZE * 4`. Se sim, chama `truncateOldMessages()`.
8. No shutdown, AgentController chama `MemoryManager.shutdown()`. Conexao SQLite fechada.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A - Truncamento de mensagem longa:**
1. `saveResponse` recebe conteudo de 80KB.
2. `MemoryManager` trunca para 65536 bytes (UTF-8).
3. Loga warning: `[MemoryManager] Message content truncated from 81920 to 65536 bytes.`
4. Conteudo truncado e persistido.

---

## 7. Requisitos Nao-Funcionais

Ver memory.md secao 7 para os requisitos nao-funcionais de persistencia. MemoryManager herda os mesmos SLAs via delegacao aos repositorios.

---

## 8. Design e Interface

### 8.1 Conversation

```typescript
interface Conversation {
  id: string;        // o id do chat do Telegram, para a conversa sobreviver a reinicios
  userId: string;
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
  private dirty: boolean;   // ver 8.5

  constructor(config: { dbPath: string; windowSize: number; dbMaxSizeMb: number });

  // Ciclo de vida
  async initialize(): Promise<void>;
  async shutdown(): Promise<void>;

  // Conversas
  createConversation(userId: string, id?: string): Conversation;
  getConversation(conversationId: string): Conversation | null;

  // Mensagens
  saveMessage(
    conversationId: string,
    role: "user" | "assistant" | "system" | "tool",
    content: string,
    toolName?: string,
    toolCallId?: string,
    metadata?: string
  ): Message;
  saveResponse(conversationId: string, result: AgentLoopResult, delivered?: string): void;
  getRecentMessages(conversationId: string): Message[];
  clearMessages(conversationId: string): number;   // /novo - apaga historico, mantem a conversa

  // Manutencao
  truncateOldMessages(conversationId: string): number;
}
```

### 8.4 Database Singleton

A conexao SQLite e gerenciada como Singleton para garantir uma unica instancia de `Database` (sql.js) em todo o processo. O Singleton e encapsulado dentro do `MemoryManager` - a instancia de `Database` e criada em `initialize()` e fechada em `shutdown()`. Nenhum outro modulo acessa `new Database(...)` diretamente.

```typescript
// Padrao: Singleton via lazy initialization gerenciada pelo facade
class MemoryManager {
  private static dbInstance: Database | null = null;

  async initialize(): Promise<void> {
    if (MemoryManager.dbInstance) {
      this.db = MemoryManager.dbInstance;          // reutiliza conexao existente
    } else {
      const SQL = await initSqlJs();               // sql.js: SQLite em wasm, em memoria
      this.db = fs.existsSync(this.dbPath)
        ? new SQL.Database(fs.readFileSync(this.dbPath))   // carrega o arquivo inteiro
        : new SQL.Database();
      this.db.run("PRAGMA foreign_keys=ON;");
      this.db.run("PRAGMA auto_vacuum=INCREMENTAL;");
      this.runMigrations();
      MemoryManager.dbInstance = this.db;
    }
    this.conversationRepo = new SqliteConversationRepository(this.db);
    this.messageRepo = new SqliteMessageRepository(this.db);
    this.startAutoSave();                          // timer de 5s, ver 8.5
    this.checkDbSize();
  }

  async shutdown(): Promise<void> {
    this.saveToDisk();        // ANTES da flag: a guarda de saveToDisk aborta com ela ligada
    this.isShutdown = true;
    clearInterval(this.saveInterval);
    this.db.close();
    MemoryManager.dbInstance = null;
  }
}
```

**Sem `journal_mode=WAL`.** O backend e wasm em memoria; WAL nao faz nada aqui. Persistencia e
reescrita do arquivo inteiro (8.5).

**Banco corrompido:** o construtor `new SQL.Database(buffer)` aceita qualquer buffer, entao arquivo
cortado ou lixo so falham na primeira consulta. `initialize()` roda `SELECT 1 FROM sqlite_master`
dentro do mesmo `try`: se ela ou o construtor lancam, o arquivo e copiado para `<dbPath>.bak` e um
banco vazio e criado. O boot prossegue com warning em vez de abortar. Antes, a primeira consulta
rodava fora do `try` (nos PRAGMAs), e o boot morria sem recuperacao.

`shortcut:` a consulta pega arquivo cortado e arquivo que nao e SQLite, nao um byte alterado no meio
de uma pagina de dados (isso exigiria `PRAGMA quick_check`, que le o banco inteiro a cada boot).

**Contrato:**
- `dbInstance` e estatica e privada. Apenas `MemoryManager` gerencia seu ciclo de vida.
- `initialize()` e idempotente - chamadas repetidas reutilizam a conexao existente.
- `shutdown()` fecha a conexao e zera `dbInstance`. Apos shutdown, uma nova chamada a `initialize()` cria uma nova conexao.
- O padrao Singleton garante que `ConversationRepository` e `MessageRepository` (instanciados internamente pelo facade) compartilhem a mesma conexao sem necessidade de injecao explicita.
- Consequencia para testes: duas instancias de `MemoryManager` no mesmo processo compartilham o banco silenciosamente. Testes precisam chamar `shutdown()` entre casos.

### 8.5 Persistencia em disco

O backend e `sql.js` (SQLite compilado para wasm), que opera em memoria. Persistir significa
exportar o banco inteiro e reescrever o arquivo - nao ha escrita incremental.

**Flag de sujeira:** um timer de 5 segundos chama `saveToDisk()`, que retorna imediatamente se nada
mudou. Sem isso, um banco de ate `DB_MAX_SIZE_MB` (padrao 500) seria serializado e reescrito a cada
5 segundos mesmo com o bot ocioso.

Marcam o banco como sujo: `saveMessage()`, `createConversation()`, `clearMessages()`,
`checkDbSize()` quando compacta, e **`runMigrations()`**.

**Gravacao atomica.** `saveToDisk()` grava `<dbPath>.tmp` e troca o arquivo com `fs.renameSync`.
Gravar direto em `dbPath` deixava um banco cortado se o processo morresse no meio da escrita, e a
recuperacao de banco corrompido (8.4) so existe no boot seguinte. Se a gravacao ou o rename falham,
o erro e logado, `dirty` continua ligado e o proximo autosave tenta de novo; o arquivo anterior fica
intacto. No Windows o rename falha se outro processo mantem o `dbPath` aberto.

**Migracoes contam como escrita.** Se `runMigrations()` nao marcar sujeira, o novo schema existe
apenas em memoria: o arquivo mantem o schema antigo, a migracao reexecuta a cada boot, e so e
persistida quando alguma escrita de linha nao relacionada acontece.

**Ordem no shutdown:** `saveToDisk()` roda **antes** de `isShutdown = true`, porque a propria
guarda de `saveToDisk()` aborta quando essa flag esta ligada. Inverter a ordem faz todo shutdown
limpo descartar as mudancas pendentes.

**Checagem de tamanho a cada gravacao.** `saveToDisk()` chama `checkDbSize()` logo apos escrever,
quando o tamanho em disco e o real. Se passar de `DB_MAX_SIZE_MB`, roda `VACUUM` e marca sujo - o
proximo autosave grava o banco compactado. `checkDbSize()` **nao** chama `saveToDisk()`: seria
recursao, e o `dirty` recem-zerado faria a chamada interna nao gravar nada.

Antes a checagem rodava **apenas no boot**, entao o limite configurado nunca valia durante o uso -
um banco podia crescer indefinidamente ate o proximo restart.

---

## 9. Modelo de Dados

MemoryManager nao define schema proprio. O schema SQLite esta documentado em `memory.md` secao 9 (source of truth). MemoryManager opera sobre as tabelas `conversations` e `messages` via repositorios.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| `sql.js` | Obrigatoria | Sem driver, initialize() falha. |
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
| EC-06: DB excede tamanho maximo | Arquivo `.db` > `DB_MAX_SIZE_MB`, verificado no boot **e a cada gravacao em disco**. | `VACUUM` completo executado, banco marcado como sujo. Warning logado. |
| EC-08: `windowSize` zero ou negativo | `MEMORY_WINDOW_SIZE=0` no `.env`. | Nao chega mais ao MemoryManager: `validateConfig()` recusa valores `< 1` (ver `configuration.md` 3). Se chegasse, `saveMessage()` dispararia `deleteOldMessages(id, 0)` - cujo `LIMIT 0` **apaga a conversa inteira** a cada mensagem salva. Perda de dados, nao janela vazia. |
| EC-07: Operacao apos shutdown | Chamada a qualquer metodo publico apos `shutdown()`. | Lanca erro: `"MemoryManager is shut down."` Um flag interno `isShutdown` controla isso - setado como `true` no inicio de `shutdown()` e verificado no inicio de cada metodo publico. Este guard previne comportamento indefinido durante race conditions entre shutdown e mensagens em voo. |
---

## 12. Seguranca e Privacidade

- **DB path:** Configurado via `DB_PATH`. Arquivo nunca commitado no Git.
- **Sem logs de conteudo:** MemoryManager nao loga conteudo de mensagens. Apenas metadados (ID, role, tamanho).
- **Truncamento seguro:** Conteudo truncado preserva integridade UTF-8 - nao corta no meio de um caractere multi-byte.

---

## 13. Plano de Rollout

Entregue por completo. Coberto por `tests/memory.test.ts` e `tests/memory-window.test.ts` (janela,
limite zero, validacao de config e limite de tamanho fora do boot).

---

## 14. Open Questions

(Nenhuma no momento - este spec foi criado para resolver o gap critico de documentacao.)
