# Spec: Core Tools (Filesystem Operations)

---

## 1. Resumo

As tools de core filesystem expõem operações de leitura, escrita e listagem de arquivos ao Agent Loop via ToolRegistry. São as tools fundamentais referenciadas por skills e pelo pipeline de documentação. Operam exclusivamente dentro de `WORKSPACE_ROOT` por segurança. Estas três tools (`criar_arquivo`, `ler_arquivo`, `listar_arquivos`) são as ÚNICAS tools built-in do MVP. Nenhuma outra tool esta planejada para a versão 1 (web search, code execution, shell access, etc. ficam para versões futuras).

---

## 2. Contexto e Motivação

**Problema:**
tools.md define o framework de tools (registro, factory, validação) mas não define as implementações concretas. skill-user.md referencia `criar_arquivo` e `ler_arquivo`. agent-loop.md mostra exemplos com estas tools. Sem um spec formal, cada implementação difere em path resolution, encoding e tratamento de erros.

**Por que agora:**
As tools de filesystem são o primeiro conjunto de ferramentas que o agente usa para gerar documentos, specs e outputs estruturados. Sem definição precisa de contrato, o comportamento em edge cases (paths com `..`, arquivos binários, encoding) é imprevisível.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir `CriarArquivoTool` com validação de path e escrita atômica.
- [ ] G-02: Definir `LerArquivoTool` com detecção de encoding e limite de tamanho.
- [ ] G-03: Definir `ListarArquivosTool` com glob pattern opcional.
- [ ] G-04: Todas as tools resolvem paths contra `WORKSPACE_ROOT` e recusam path traversal.

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Não suportaremos escrita/leitura de binários. Apenas texto (UTF-8).
- NG-02: Não suportaremos operações recursivas profundas. Profundidade máxima de listagem: 3 níveis.
- NG-03: Não suportaremos watchers de arquivo ou hot-reload via tools.

---

## 5. Ferramentas

### 5.1 CriarArquivoTool (`criar_arquivo`)

**Definição para ToolRegistry:**

```typescript
{
  name: "criar_arquivo",
  description: "Cria ou sobrescreve um arquivo de texto no workspace. Retorna confirmação com caminho relativo e tamanho em bytes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Ex: 'specs/novo-arquivo.md'" },
      content: { type: "string", description: "Conteúdo do arquivo em UTF-8." }
    },
    required: ["path", "content"]
  }
}
```

**Comportamento:**
1. Resolve `path` contra `WORKSPACE_ROOT` (`path.resolve(workspaceRoot, input.path)`).
2. Verifica que o path resolvido começa com `WORKSPACE_ROOT` (bloqueia path traversal).
3. Cria diretórios intermediários se não existirem (`fs.mkdirSync(dirname, { recursive: true })`).
4. Escreve o conteúdo com `fs.writeFileSync(resolvedPath, content, 'utf-8')`.
5. Retorna `ToolResult { success: true, output: "Arquivo criado: specs/novo-arquivo.md (1234 bytes)" }`.

**Edge cases:**
- Path contém `..` → recusado: `output: "Erro: caminho fora do workspace permitido."`
- Path absoluto → recusado: `output: "Erro: use caminho relativo ao workspace."`
- Falha de permissão → `success: false, error: "EACCES: permissão negada para escrever em <path>."`
- Conteúdo vazio → arquivo criado com string vazia (permitido).

### 5.2 LerArquivoTool (`ler_arquivo`)

**Definição para ToolRegistry:**

```typescript
{
  name: "ler_arquivo",
  description: "Lê o conteúdo de um arquivo de texto do workspace. Retorna o conteúdo como string UTF-8.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Ex: 'specs/PRD.md'" },
      maxBytes: { type: "number", description: "Limite opcional de bytes a ler. Padrão: 65536 (64KB)." }
    },
    required: ["path"]
  }
}
```

**Comportamento:**
1. Resolve `path` contra `WORKSPACE_ROOT`.
2. Verifica que o path resolvido começa com `WORKSPACE_ROOT`.
3. Verifica existência do arquivo. Se não existe → `success: false, output: "Erro: arquivo não encontrado: <path>."`.
4. Verifica tamanho contra `maxBytes` (default 65536). Se maior → lê apenas os primeiros `maxBytes` e loga: `[LerArquivoTool] Arquivo truncado de <total> para <maxBytes> bytes.`.
5. Lê com `fs.readFileSync(resolvedPath, 'utf-8')`.
6. Retorna `ToolResult { success: true, output: "<conteúdo>" }`.

**Edge cases:**
- Arquivo binário → `try/catch` no `readFileSync('utf-8')`. Se lançar, retorna: `output: "Erro: arquivo não é texto UTF-8 válido."`.
- Encoding inválido → caracteres de substituição (`\uFFFD`) são aceitos no output.
- Path é diretório → `output: "Erro: '<path>' é um diretório, não um arquivo."`.

### 5.3 ListarArquivosTool (`listar_arquivos`)

**Definição para ToolRegistry:**

```typescript
{
  name: "listar_arquivos",
   description: "Lista arquivos e diretórios no workspace. Suporta filtro por extensão de arquivo (*.md, *.ts, *.json).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Use '.' para raiz." },
       pattern: { type: "string", description: "Filtro por extensão de arquivo. Ex: '*.md', '*.ts', '*.json'. Opcional." }
    },
    required: ["path"]
  }
}
```

**Comportamento:**
1. Resolve `path` contra `WORKSPACE_ROOT`.
2. Verifica que o path resolvido começa com `WORKSPACE_ROOT`.
3. Lê diretório com `fs.readdirSync(resolvedPath, { withFileTypes: true })`. Profundidade máxima: 3 níveis abaixo do path base. O path base resolvido é nível 0. A travessia desce no máximo 3 níveis abaixo (nível 1, nível 2, nível 3). Exemplo: se path base é `./specs`, o nível 0 é `specs/`, nível 1 é `specs/sub1/`, nível 2 é `specs/sub1/sub2/`, nível 3 é `specs/sub1/sub2/sub3/`. Diretórios no nível 4 ou abaixo são listados com `"(mais arquivos...)"`.
4. Filtra por `pattern` se fornecido (match simples de extensão: `*.md`, `*.ts`, `*.json`).
5. Retorna lista formatada: `"Arquivos em <path>:\n  arquivo1.md (1234 bytes)\n  subdir/ (diretório)"`.

**Edge cases:**
- Diretório vazio → `output: "Nenhum arquivo encontrado em '<path>'."`.
- Path não é diretório → `output: "Erro: '<path>' não é um diretório."`.
- Profundidade excedida → diretórios além do nível 3 são listados com `"(mais arquivos...)"`.

---

## 6. Segurança Comum

Todas as tools implementam as seguintes validações, alinhadas com tools.md seção 12:

- **Path traversal bloqueado:** `path.resolve(workspaceRoot, inputPath)` deve resultar em path que começa com `workspaceRoot`. Se não começar, recusar com erro.
- **Paths absolutos recusados:** `path.isAbsolute(inputPath)` → erro.
- **Sem acesso a `.env` ou `../`:** A validação de prefixo captura qualquer tentativa de escape.
- **Workspace root verificado:** Se `WORKSPACE_ROOT` não existir na inicialização, é criado automaticamente (ver tools.md seção 12).

---

## 7. Registro

As três tools são registradas no `ToolRegistry` durante o bootstrap (passo 4: "Inicializar ToolRegistry"). O registro é feito via código TypeScript — as tools não são carregadas do filesystem como skills.

```typescript
// bootstrap (pseudo)
const toolRegistry = new ToolRegistry();
toolRegistry.register(new CriarArquivoTool(workspaceRoot));
toolRegistry.register(new LerArquivoTool(workspaceRoot));
toolRegistry.register(new ListarArquivosTool(workspaceRoot));
```

---

## 8. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| `fs` (Node.js) | Obrigatória | Nenhuma tool de filesystem funciona. |
| `WORKSPACE_ROOT` (env) | Obrigatória | Tools recusam qualquer operação (path base indefinido). |
| `ToolRegistry` | Obrigatória | Tools não são descobertas pelo AgentLoop. |

---

## 9. Open Questions

(Nenhuma — este spec foi criado para resolver o gap.)
