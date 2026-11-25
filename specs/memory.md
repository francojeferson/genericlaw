# Spec: Memory Module (SQLite Persistence)

---

> **\u26a0\ufe0f TRADEOFF: Estrategia de migracao destrutiva para MVP.** Se o schema do banco de dados divergir do esperado na inicializacao, o arquivo `db.sqlite` e renomeado para `db.sqlite.bak` e um novo banco vazio e criado. Isso significa que TODOS os dados de conversas anteriores sao perdidos na migracao. Esta decisao e intencional para o MVP - migracoes incrementais (ALTER TABLE) serao implementadas na versao 2. Para detalhes, ver secao 9 (Manutencao de Banco de Dados).

---

## 1. Resumo

O modulo de persistencia de estado do GeneriClaw gerencia tanto as conversas de longo prazo em banco de dados SQLite (`sql.js`) quanto atua como manager da janela de contexto para impedir que o limite maximo do envelope de tokens da IA (Context Window) estoure.

---

## 2. Contexto e Motivacao

**Problema:**
LLMs sao stateless - eles esquecem tudo que foi dito na interacao anterior de uma API REST call.
Sem armazenamento persistente, o robo perde a utilidade primaria de um "Agente Pessoal".

**Evidencias:**
Tentativas de armazenar arrays in-memory no Node.js funcionam apenas ate o app ser encerrado/reiniciado (hot-reload da infra ou npm dev reload). O historico vaporizava.

**Por que agora:**
A adocao do SQLite e veloz, serverless (um arquivo fisico unico), suporta chamadas sincronas rapidas (bloqueios impercetiveis para volumes unicos de acesso Telegram) e nao consome infra adicional. 

---

## 3. Goals (Objetivos)

- [ ] G-01: Prover Storage fixo e rapido de mensagens do Telegram para recriar as conversas ativas.
- [ ] G-02: Possuir um `MemoryManager` central (Facade) que decide automaticamente quando as mensagens velhas deverao ser ignoradas (Truncamento nativo) sem apagar sua versao persistente historica.
- [ ] G-03: Ranquear requisicoes de SQLite usando Repository Pattern, desacoplando SQL views puro do Agent Loop principal.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo de Write Sync | N/A | < 10ms | Constante |
| Limite de Arquivo DB | 0.0 MB | Manter sob 500 MB (Vacuum ocasional) | 1 Ano |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Nao criara banco distribuido de Grafos ou Chroma Vector Database. A intencao e ter memoria conversacional direta, sem Sematic Search Complexo inicialmente.
- NG-02: ORMs como Prisma, TypeORM etc. Usaremos SQL nativo por leveza e clareza. 

---

## 5. Usuarios e Personas

**Modulos primarios:** 
- O `AgentController` (grava input do usuario e resposta do agente, consulta historico para contexto).
- A Ferramenta Generica de Sistema (apenas le seu proprio historico pra sumarizacao futura).

### Interfaces do Repository

**ConversationRepository:**
```typescript
interface ConversationRepository {
  create(userId: string, id?: string): Conversation;   // id = chat id do Telegram
  findById(id: string): Conversation | null;
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

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O Singleton de DB deve criar a tabela de historico (`conversations` e `messages`) sozinho no startup se nao existirem. | Must | Excluir db antigo; reiniciar app; arquivo data/ db.sqlite reaparece limpo. |
| RF-02 | ~~O Storage deve usar WAL~~ | Descartado | Nao se aplica ao `sql.js`: o banco vive em memoria e nao ha locks de arquivo a evitar. Ver secao 9. |
| RF-03 | A classe abstrata repassara ao Agent Loop somente o numero `MEMORY_WINDOW_SIZE` de mensagens recentes. | Must | Uma chamada REST pro Gemini nao falhara por estouro de token via historico inchado (1M text words). |

### 6.2 Fluxo Principal (Happy Path)

1. Usuario envia "Oi agente".
2. `ConversationRepository` localiza a conversa pelo seu id, que e o id do chat do Telegram.
3. `MessageRepository` persiste a nova mensagem `role="user"` com texto associado ao ID.
4. `MemoryManager` extrai da DB as ultimas "N" conversas usando LIMIT.
5. Devolve array `[]` filtrado para AgentLoop atuar.
6. A resposta do bot com `role="assistant"` ou `role="tool"` e persistida analogamente pelas mesmas classes.

### 6.3 Fluxos Alternativos

Falhas de Banco - Vide [11. Edge Cases e Tratamento de Erros](#11-edge-cases-e-tratamento-de-erros)

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Transacoes Seguras | Auto-commit nativo | O Node e single-thread e o `AgentController` ja serializa por conversa; nao ha escrita concorrente a coordenar. |
| RNF-02 | Tempo de insercao | < 10ms | API sincrona do `sql.js` (em memoria). |
| RNF-03 | Tempo de consulta de historico | < 5ms | LIMIT query simples. |
| RNF-04 | Tamanho maximo por mensagem | 65536 bytes | Truncamento aplicado antes da insercao. |

---

## 8. Design e Interface

Pura estrutura sem interface visual (ver `sqlite-viewer` VSCode extensao para debbug interno).

---

## 9. Modelo de Dados

Schema SQLite completo. Criado automaticamente na inicializacao pelo Singleton de DB se as tabelas nao existirem.

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT DEFAULT '',                      -- legado: nunca lido nem escrito
  provider      TEXT NOT NULL DEFAULT 'gemini',       -- legado: nunca lido nem escrito
  blocked       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
DROP INDEX IF EXISTS idx_conversations_user_id;       -- nenhuma consulta busca por usuario

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

CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id);
```

Pragma de inicializacao: `PRAGMA foreign_keys=ON; PRAGMA auto_vacuum=INCREMENTAL;`

`journal_mode=WAL` **nao** e usado: o backend e `sql.js`, um build wasm que opera inteiramente em
memoria e persiste via export/escrita do arquivo inteiro. WAL e inocuo nesse modelo.

**Colunas legado.** `title` e `provider` nao tem leitor nem escritor desde que
`updateConversationTitle()` e `getConversationsByUser()` foram removidos. Ficam no `CREATE TABLE`
de proposito: `CREATE TABLE IF NOT EXISTS` nao altera bancos ja existentes, entao tira-las do DDL
criaria dois formatos de schema em circulacao - bancos novos sem as colunas, antigos com - sem
nenhum ganho. O `INSERT` de `create()` ja nao as menciona, e `Conversation` nao as expoe.

**Indices sao removidos com `DROP INDEX IF EXISTS` explicito.** Apagar a linha `CREATE INDEX` nao
basta: um banco ja existente mantem o indice para sempre, e cada escrita continua pagando por ele.
Pelo mesmo motivo, **redefinir** um indice exige nome novo - `CREATE INDEX IF NOT EXISTS` encontra
o antigo e mantem silenciosamente a definicao velha.

**Indice alinhado a ordenacao:** todas as consultas de mensagem ordenam por `id` (ver politica de
retencao abaixo), entao o indice cobre `(conversation_id, id)`. Um indice sobre `created_at` obriga
o SQLite a um passo extra de ordenacao (`USE TEMP B-TREE FOR ORDER BY`). Nao ha indice por `role`
porque nenhuma consulta filtra por ele - indice sem consulta e custo de escrita puro.

**Nome novo em migracao de indice:** `CREATE INDEX IF NOT EXISTS` com um nome ja existente e no-op
e mantem silenciosamente a definicao antiga. Trocar a definicao de um indice exige nome novo mais
`DROP INDEX IF EXISTS` do antigo.

### Manutencao de Banco de Dados

**Politica de retencao:** Mensagens de conversas com mais de `MEMORY_WINDOW_SIZE * 4` registros sao truncadas automaticamente no momento da insercao. O `MemoryManager.truncateOldMessages(conversationId)` mantem apenas as `MEMORY_WINDOW_SIZE` mensagens mais recentes daquela conversa, removendo as antigas via `DELETE ... WHERE id NOT IN (SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?)`.

**Ordenacao por `id`, nao por `created_at`:** os timestamps sao ISO com milissegundos, e mensagens
de assistant e tool escritas na mesma iteracao do agente colidem no mesmo milissegundo. O
desempate entre valores iguais nao e especificado pelo SQLite; `id` (AUTOINCREMENT) e a ordem de
insercao por definicao.

**Vacuum:** Executado via `PRAGMA auto_vacuum=INCREMENTAL` e `PRAGMA incremental_vacuum` a cada 500 insercoes (contador interno no MemoryManager). O objetivo e manter o arquivo `.db` sob 500MB. Se o arquivo exceder 500MB, um `VACUUM` completo e executado na proxima inicializacao.

**Estrategia de migracao de schema:** Para MVP, a estrategia e "recriar se invalido". O sistema verifica se as tabelas existem com o schema esperado usando `PRAGMA table_info`. Se houver divergencia, o banco e renomeado para `db.sqlite.bak` e recriado do zero. Migracoes incrementais (ALTER TABLE) serao adicionadas na versao 2.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| `sql.js` | Obrigatoria | O agente vai quebrar a Main.ts na instancializacao. |
| Filesystem (`fs`) | Obrigatorio | DB path tem que ser gerido e gravado via Node FS Perms. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Arquivo Lock file corrupto | Desligamento forcado de energia no Write SQLite local. | SQLite reabre do journaling automatico e read de forma integra sem interrupcoes maiores. |
| EC-02: Null Bytes na Mensagem do Usuario | Receber bytes invisiveis no TG causando Erro de syntax DB. | Stripping na entrada `content.replace(/\u0000/g, '')`. O DB nao engole a query suja. |
| EC-03: Memoria Enorme de Resposta de LLM | O modelo decide cuspir 16k tokens em Output. | Limite aplicado: 64KB por mensagem (65536 bytes). MemoryManager trunca `content` para 65536 bytes (medidos em UTF-8 bytes, nao em caracteres) antes de inserir no banco. Caracteres multi-byte (emoji, CJK) consomem multiplos bytes - uma mensagem com muitos emojis pode atingir o limite com menos de 65536 caracteres. Mensagens truncadas logam warning: `[MemoryManager] Message content truncated from X to 65536 bytes.` |

---

## 12. Seguranca e Privacidade

- **Arquivos DB Sensiveis:** O `db.sqlite` jamais pode ir pro Git (Adicionar no `.gitignore` /data).
- **Sem senhas cruas no prompt:** O DB grava as msgs do usuario. Nao logaremos APIs ali como System Prompts secretos pra evitar persistencia indevida.

---

## 13. Plano de Rollout

Rollout instantaneo para DB Version 1. Scripts de Migration explicitos nao sao escopo inicial, pra reset bastando apagar e reinjetar no DB_PATH local de DEV.

---

## 14. Open Questions

- Q1 (Resolvida): Arquivos `.bak` acumulam no disco. Comportamento: na inicializacao, se ja existir um `db.sqlite.bak` de uma migracao anterior, ele e sobrescrito (apenas o backup mais recente e mantido). Um warning e logado: `[MemoryManager] Database schema changed. Old database backed up to data/db.sqlite.bak. Remove manually if no longer needed.`
- Q2 (Resolvida): O fator `MEMORY_WINDOW_SIZE * 4` e uma heuristica de buffer: mantem 4x a janela de contexto no banco para permitir scrollback ocasional sem estourar o contexto do LLM. O truncamento ocorre apenas no carregamento para o LLM (`MEMORY_WINDOW_SIZE` mensagens), mas o banco retem 4x para consultas futuras ou debugging. O fator 4x e empirico e pode ser ajustado com dados reais de uso.
- Q3 (Resolvida): EC-03 corrigido. O limite aplicado e 64KB por mensagem (consistente com RNF-02 do llm-provider.md). O MemoryManager trunca `content` para 65536 bytes (UTF-8) antes de inserir no banco. Mensagens truncadas logam warning: `[MemoryManager] Message content truncated from X to 65536 bytes.`
