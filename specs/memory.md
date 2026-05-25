# Spec: Memory Module (SQLite Persistence)

---

> **⚠️ TRADEOFF: Estratégia de migração destrutiva para MVP.** Se o schema do banco de dados divergir do esperado na inicialização, o arquivo `db.sqlite` é renomeado para `db.sqlite.bak` e um novo banco vazio é criado. Isso significa que TODOS os dados de conversas anteriores são perdidos na migração. Esta decisão é intencional para o MVP — migrações incrementais (ALTER TABLE) serão implementadas na versão 2. Para detalhes, ver seção 9 (Manutenção de Banco de Dados).

---

## 1. Resumo

O módulo de persistência de estado do GeneriClaw gerencia tanto as conversas de longo prazo em banco de dados SQLite (`better-sqlite3`) quanto atua como manager da janela de contexto para impedir que o limite maximo do envelope de tokens da IA (Context Window) estoure.

---

## 2. Contexto e Motivação

**Problema:**
LLMs são stateless - eles esquecem tudo que foi dito na interação anterior de uma API REST call.
Sem armazenamento persistente, o robô perde a utilidade primária de um "Agente Pessoal".

**Evidências:**
Tentativas de armazenar arrays in-memory no Node.js funcionam apenas até o app ser encerrado/reiniciado (hot-reload da infra ou npm dev reload). O histórico vaporizava.

**Por que agora:**
A adoção do SQLite é veloz, serverless (um arquivo físico único), suporta chamadas síncronas rápidas (bloqueios impercetiveis para volumes unicos de acesso Telegram) e não consome infra adicional. 

---

## 3. Goals (Objetivos)

- [ ] G-01: Prover Storage fixo e rápido de mensagens do Telegram para recriar as conversas ativas.
- [ ] G-02: Possuir um `MemoryManager` central (Facade) que decide automaticamente quando as mensagens velhas deverão ser ignoradas (Truncamento nativo) sem apagar sua versão persistente histórica.
- [ ] G-03: Ranquear requisições de SQLite usando Repository Pattern, desacoplando SQL views puro do Agent Loop principal.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo de Write Sync | N/A | < 10ms | Constante |
| Limite de Arquivo DB | 0.0 MB | Manter sob 500 MB (Vacuum ocasional) | 1 Ano |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Não criará banco distribuído de Grafos ou Chroma Vector Database. A intenção é ter memória conversacional direta, sem Sematic Search Complexo inicialmente.
- NG-02: ORMs como Prisma, TypeORM etc. Usaremos SQL nativo `better-sqlite3` por leveza e clareza. 

---

## 5. Usuários e Personas

**Modulos primarios:** 
- O `AgentController` (grava input do usuario e resposta do agente, consulta historico para contexto).
- A Ferramenta Generica de Sistema (apenas le seu proprio historico pra sumarizacao futura).

### Interfaces do Repository

**ConversationRepository:**
```typescript
interface ConversationRepository {
  create(userId: string, provider?: string): Conversation;
  findById(id: string): Conversation | null;
  findByUserId(userId: string): Conversation[];
  markBlocked(conversationId: string): void;
  isBlocked(conversationId: string): boolean;
  updateTitle(conversationId: string, title: string): void;
}
```

**MessageRepository:**
```typescript
interface MessageRepository {
  create(conversationId: string, role: string, content: string, toolName?: string, toolCallId?: string, metadata?: string): Message;
  findByConversationId(conversationId: string, limit?: number): Message[];
  countByConversationId(conversationId: string): number;
  deleteOldMessages(conversationId: string, keepCount: number): number;
}
```

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O Singleton de DB deve criar a tabela de histórico (`conversations` e `messages`) sozinho no startup se não existirem. | Must | Excluir db antigo; reiniciar app; arquivo data/ db.sqlite reaparece limpo. |
| RF-02 | O Storage deve usar WAL (Write-Ahead Logging) ativo pra manter leitura sem block | Must | Múltiplas msgs via Telegram não congelam o bot por locks do sqlite3 nativo. |
| RF-03 | A classe abstrata repassará ao Agent Loop somente o número `MEMORY_WINDOW_SIZE` de mensagens recentes. | Must | Uma chamada REST pro Gemini não falhará por estouro de token via histórico inchado (1M text words). |

### 6.2 Fluxo Principal (Happy Path)

1. Usuário envia "Oi agente".
2. `ConversationRepository` localiza UUID conversacional ativo do User_ID.
3. `MessageRepository` persiste a nova mensagem `role="user"` com texto associado ao ID.
4. `MemoryManager` extrai da DB as últimas "N" conversas usando LIMIT.
5. Devolve array `[]` filtrado para AgentLoop atuar.
6. A resposta do bot com `role="assistant"` ou `role="tool"` é persistida analogamente pelas mesmas classes.

### 6.3 Fluxos Alternativos

Falhas de Banco - Vide [11. Edge Cases e Tratamento de Erros](#11-edge-cases-e-tratamento-de-erros)

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Transações Seguras | Auto-commit nativo | WAL ativo resolve concorrencia Single thread node. |
| RNF-02 | Tempo de inserção | < 10ms | `better-sqlite3` sync. |
| RNF-03 | Tempo de consulta de histórico | < 5ms | LIMIT query simples. |
| RNF-04 | Tamanho máximo por mensagem | 65536 bytes | Truncamento aplicado antes da inserção. |

---

## 8. Design e Interface

Pura estrutura sem interface visual (ver `sqlite-viewer` VSCode extensão para debbug interno).

---

## 9. Modelo de Dados

Schema SQLite completo. Criado automaticamente na inicialização pelo Singleton de DB se as tabelas não existirem.

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT DEFAULT '',
  provider      TEXT NOT NULL DEFAULT 'gemini',
  blocked       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content         TEXT NOT NULL,
  tool_name       TEXT,
  tool_call_id    TEXT,
  metadata        TEXT DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(conversation_id, role);
```

Pragma de inicialização: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA auto_vacuum=INCREMENTAL;`

### Manutenção de Banco de Dados

**Política de retenção:** Mensagens de conversas com mais de `MEMORY_WINDOW_SIZE * 4` registros são truncadas automaticamente no momento da inserção. O `MemoryManager.truncateOldMessages(conversationId)` mantém apenas as `MEMORY_WINDOW_SIZE` mensagens mais recentes daquela conversa, removendo as antigas via `DELETE ... WHERE id NOT IN (SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?)`.

**Vacuum:** Executado via `PRAGMA auto_vacuum=INCREMENTAL` e `PRAGMA incremental_vacuum` a cada 500 inserções (contador interno no MemoryManager). O objetivo é manter o arquivo `.db` sob 500MB. Se o arquivo exceder 500MB, um `VACUUM` completo é executado na próxima inicialização.

**Estratégia de migração de schema:** Para MVP, a estratégia é "recriar se inválido". O sistema verifica se as tabelas existem com o schema esperado usando `PRAGMA table_info`. Se houver divergência, o banco é renomeado para `db.sqlite.bak` e recriado do zero. Migrações incrementais (ALTER TABLE) serão adicionadas na versão 2.

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| `better-sqlite3` | Obrigatória | O agente vai quebrar a Main.ts na instancialização. |
| Filesystem (`fs`) | Obrigatório | DB path tem que ser gerido e gravado via Node FS Perms. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Arquivo Lock file corrupto | Desligamento forçado de energia no Write SQLite local. | SQLite reabre do journaling automático e read de forma íntegra sem interrupções maiores. |
| EC-02: Null Bytes na Mensagem do Usuário | Receber bytes invisíveis no TG causando Erro de syntax DB. | Stripping na entrada `content.replace(/\u0000/g, '')`. O DB não engole a query suja. |
| EC-03: Memoria Enorme de Resposta de LLM | O modelo decide cuspir 16k tokens em Output. | Limite aplicado: 64KB por mensagem (65536 bytes). MemoryManager trunca `content` para 65536 bytes (medidos em UTF-8 bytes, nao em caracteres) antes de inserir no banco. Caracteres multi-byte (emoji, CJK) consomem multiplos bytes — uma mensagem com muitos emojis pode atingir o limite com menos de 65536 caracteres. Mensagens truncadas logam warning: `[MemoryManager] Message content truncated from X to 65536 bytes.` |

---

## 12. Segurança e Privacidade

- **Arquivos DB Sensíveis:** O `db.sqlite` jamais pode ir pro Git (Adicionar no `.gitignore` /data).
- **Sem senhas cruas no prompt:** O DB grava as msgs do usuário. Não logaremos APIs ali como System Prompts secretos pra evitar persistencia indevida.

---

## 13. Plano de Rollout

Rollout instantâneo para DB Version 1. Scripts de Migration explícitos não são escopo inicial, pra reset bastando apagar e reinjetar no DB_PATH local de DEV.

---

## 14. Open Questions

- Q1 (Resolvida): Arquivos `.bak` acumulam no disco. Comportamento: na inicialização, se já existir um `db.sqlite.bak` de uma migração anterior, ele é sobrescrito (apenas o backup mais recente é mantido). Um warning é logado: `[MemoryManager] Database schema changed. Old database backed up to data/db.sqlite.bak. Remove manually if no longer needed.`
- Q2 (Resolvida): O fator `MEMORY_WINDOW_SIZE * 4` é uma heurística de buffer: mantém 4x a janela de contexto no banco para permitir scrollback ocasional sem estourar o contexto do LLM. O truncamento ocorre apenas no carregamento para o LLM (`MEMORY_WINDOW_SIZE` mensagens), mas o banco retém 4x para consultas futuras ou debugging. O fator 4x é empírico e pode ser ajustado com dados reais de uso.
- Q3 (Resolvida): EC-03 corrigido. O limite aplicado é 64KB por mensagem (consistente com RNF-02 do llm-provider.md). O MemoryManager trunca `content` para 65536 bytes (UTF-8) antes de inserir no banco. Mensagens truncadas logam warning: `[MemoryManager] Message content truncated from X to 65536 bytes.`
