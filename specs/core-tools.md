# Spec: Core Tools (Filesystem Operations)

---

## 1. Resumo

As tools de core filesystem expoem operacoes de leitura, escrita e listagem de arquivos ao Agent Loop via ToolRegistry. Sao as tools fundamentais referenciadas por skills e pelo pipeline de documentacao. Operam exclusivamente dentro de `WORKSPACE_ROOT` por seguranca. Estas tres tools (`criar_arquivo`, `ler_arquivo`, `listar_arquivos`) sao as UNICAS tools built-in do MVP. Nenhuma outra tool esta planejada para a versao 1 (web search, code execution, shell access, etc. ficam para versoes futuras).

---

## 2. Contexto e Motivacao

**Problema:**
tools.md define o framework de tools (registro, factory, validacao) mas nao define as implementacoes concretas. skill-user.md referencia `criar_arquivo` e `ler_arquivo`. agent-loop.md mostra exemplos com estas tools. Sem um spec formal, cada implementacao difere em path resolution, encoding e tratamento de erros.

**Por que agora:**
As tools de filesystem sao o primeiro conjunto de ferramentas que o agente usa para gerar documentos, specs e outputs estruturados. Sem definicao precisa de contrato, o comportamento em edge cases (paths com `..`, arquivos binarios, encoding) e imprevisivel.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir `CriarArquivoTool` com validacao de path e escrita atomica.
- [ ] G-02: Definir `LerArquivoTool` com deteccao de encoding e limite de tamanho.
- [ ] G-03: Definir `ListarArquivosTool` com glob pattern opcional.
- [ ] G-04: Todas as tools resolvem paths contra `WORKSPACE_ROOT` e recusam path traversal.

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Nao suportaremos escrita/leitura de binarios. Apenas texto (UTF-8).
- NG-02: Nao suportaremos operacoes recursivas profundas. Profundidade maxima de listagem: 3 niveis.
- NG-03: Nao suportaremos watchers de arquivo ou hot-reload via tools.

---

## 5. Ferramentas

### 5.1 CriarArquivoTool (`criar_arquivo`)

**Definicao para ToolRegistry:**

```typescript
{
  name: "criar_arquivo",
  description: "Cria ou sobrescreve um arquivo de texto no workspace. Retorna confirmacao com caminho relativo e tamanho em bytes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Ex: 'specs/novo-arquivo.md'" },
      content: { type: "string", description: "Conteudo do arquivo em UTF-8." }
    },
    required: ["path", "content"]
  }
}
```

**Comportamento:**
1. Resolve `path` contra `WORKSPACE_ROOT` via `resolveInWorkspace()` (ver 5.4).
2. Se o arquivo ja existe e `overwrite` nao e `true`, recusa a escrita.
3. Cria diretorios intermediarios se nao existirem (`fs.mkdirSync(dirname, { recursive: true })`).
4. Escreve o conteudo com `fs.writeFileSync(resolvedPath, content, 'utf-8')`.
5. Retorna `ToolResult { success: true, output: "Arquivo criado: specs/novo-arquivo.md (1234 bytes)" }`.

O parametro `overwrite` (boolean, opcional, padrao `false`) existe porque o workspace tambem guarda
documentos enviados pelo usuario (ver `telegram-input.md`). Sem ele, um modelo confuso pode destruir
um upload sem aviso. Chamadas internas que legitimamente substituem um arquivo - como o
armazenamento de uploads - passam `overwrite: true` explicitamente.

**Edge cases:**
- Path escapa do workspace -> recusado: `output: "Erro: caminho fora do workspace permitido."`, `error: "path traversal"`
- Path absoluto -> recusado: `output: "Erro: use caminho relativo ao workspace."`
- Arquivo ja existe sem `overwrite` -> `success: false, error: "already exists"`, instruindo o modelo a repetir com `overwrite=true`.
- Falha de permissao -> `success: false, error: "EACCES: permissao negada para escrever em <path>."`
- Conteudo vazio -> arquivo criado com string vazia (permitido).

### 5.2 LerArquivoTool (`ler_arquivo`)

**Definicao para ToolRegistry:**

```typescript
{
  name: "ler_arquivo",
  description: "Le o conteudo de um arquivo de texto do workspace. Retorna o conteudo como string UTF-8.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Ex: 'specs/PRD.md'" },
      maxBytes: { type: "number", description: "Bytes a ler nesta chamada. Padrao: 8192 (8KB). Maximo: 32768 (32KB)." },
      offset: { type: "number", description: "Byte inicial da leitura. Padrao: 0." }
    },
    required: ["path"]
  }
}
```

**Comportamento:**
1. Resolve `path` contra `WORKSPACE_ROOT` via `resolveInWorkspace()` (ver 5.4).
2. Verifica existencia do arquivo. Se nao existe -> `success: false, output: "Erro: arquivo nao encontrado: <path>."`.
3. Limita `maxBytes` ao teto de 32768 bytes. O teto **nao e sobrescrevivel**: um valor maior e silenciosamente reduzido.
4. Le a janela `[offset, offset + maxBytes)` do arquivo.
5. Se a leitura nao alcancou o fim do arquivo, apara o pedaco de volta a uma fronteira de caractere UTF-8 e anexa um marcador explicito: `[...leitura parcial: bytes X-Y de Z. Chame ler_arquivo novamente com offset=Y para continuar.]`
6. Retorna `ToolResult { success: true, output: "<conteudo>" }`.

**Cerca em `conhecimento/`.** O destilado de grupos (`<WORKSPACE_ROOT>/conhecimento/`) e texto de
terceiros resumido por um modelo. Quando o caminho **resolvido** cai nessa pasta (`./conhecimento/x`
e `a/../conhecimento/x` tambem contam), o pedaco lido sai embrulhado em `delimitarNaoConfiavel`, como
a mensagem de grupo lida por `historico_grupo`. O marcador de leitura parcial do passo 5 fica **fora**
da cerca, porque e nosso. Arquivos de outras pastas voltam sem cerca.

**Por que o teto e a paginacao existem:** o resultado de uma tool permanece no contexto do loop em
todas as iteracoes seguintes, entao uma leitura grande e paga repetidamente. Uma leitura unica de um
documento de ~200KB levou o prompt de 1.4k para 121k tokens em tres iteracoes. O teto limita o custo
por leitura; `offset` mantem arquivos grandes acessiveis. O marcador e obrigatorio: sem ele o modelo
acredita ter lido o arquivo inteiro e responde com confianca sobre um trecho.

**Edge cases:**
- Arquivo binario -> `try/catch` no `readFileSync('utf-8')`. Se lancar, retorna: `output: "Erro: arquivo nao e texto UTF-8 valido."`.
- Encoding invalido -> caracteres de substituicao (`\uFFFD`) sao aceitos no output.
- `offset` alem do fim do arquivo -> `success: false, error: "offset out of range"`.
- Caractere multibyte na fronteira da pagina -> aparado, nunca emitido pela metade.
- Path e diretorio -> `output: "Erro: '<path>' e um diretorio, nao um arquivo."`.

### 5.3 ListarArquivosTool (`listar_arquivos`)

**Definicao para ToolRegistry:**

```typescript
{
  name: "listar_arquivos",
   description: "Lista arquivos e diretorios no workspace. Suporta filtro por extensao de arquivo (*.md, *.ts, *.json).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Caminho relativo ao WORKSPACE_ROOT. Use '.' para raiz." },
       pattern: { type: "string", description: "Filtro por extensao de arquivo. Ex: '*.md', '*.ts', '*.json'. Opcional." }
    },
    required: ["path"]
  }
}
```

**Comportamento:**
1. Resolve `path` contra `WORKSPACE_ROOT`.
2. Verifica que o path resolvido comeca com `WORKSPACE_ROOT`.
3. Le diretorio com `fs.readdirSync(resolvedPath, { withFileTypes: true })`. Profundidade maxima: 3 niveis abaixo do path base. O path base resolvido e nivel 0. A travessia desce no maximo 3 niveis abaixo (nivel 1, nivel 2, nivel 3). Exemplo: se path base e `./specs`, o nivel 0 e `specs/`, nivel 1 e `specs/sub1/`, nivel 2 e `specs/sub1/sub2/`, nivel 3 e `specs/sub1/sub2/sub3/`. Diretorios no nivel 4 ou abaixo sao listados com `"(mais arquivos...)"`.
4. Filtra por `pattern` se fornecido (match simples de extensao: `*.md`, `*.ts`, `*.json`).
5. Retorna lista formatada: `"Arquivos em <path>:\n  arquivo1.md (1234 bytes)\n  subdir/ (diretorio)"`.

**Edge cases:**
- Diretorio vazio -> `output: "Nenhum arquivo encontrado em '<path>'."`.
- Path nao e diretorio -> `output: "Erro: '<path>' nao e um diretorio."`.
- Profundidade excedida -> diretorios alem do nivel 3 sao listados com `"(mais arquivos...)"`.

---

### 5.4 Contencao de path (`resolveInWorkspace`)

As tres tools usam um unico helper exportado por `tools/registry.ts`, em vez de repetir a
verificacao:

```typescript
function isInsideWorkspace(workspaceAbs: string, absPath: string): boolean;
function resolveInWorkspace(workspaceRoot: string, inputPath: string): string | null;
```

`resolveInWorkspace()` retorna o path absoluto, ou `null` se ele escapa do workspace.

**A verificacao e feita com `path.relative`, nunca com `startsWith`.** Prefixo de string nao e
contencao: com `WORKSPACE_ROOT = ./output`, o caminho `../output-evil/segredos` resolve para
`.../output-evil/segredos`, que *comeca* com `.../output` e passaria na checagem de prefixo. A
regra correta e: o path relativo do workspace ate o alvo nao pode comecar com `..` nem ser
absoluto. O workspace raiz (relativo vazio) conta como dentro.

---

## 6. Seguranca Comum

Todas as tools implementam as seguintes validacoes, alinhadas com tools.md secao 12:

- **Path traversal bloqueado:** via `resolveInWorkspace()` (ver 5.4), usando `path.relative`.
- **Paths absolutos recusados:** `path.isAbsolute(inputPath)` -> erro.
- **Sem acesso a `.env` ou `../`:** a checagem relativa captura qualquer tentativa de escape, inclusive diretorios irmaos que compartilham o prefixo do workspace.
- **Escrita nao destrutiva por padrao:** `criar_arquivo` recusa sobrescrever sem `overwrite: true` (ver 5.1).
- **Leitura limitada:** `ler_arquivo` tem teto de 32KB por chamada, nao sobrescrevivel (ver 5.2).
- **Workspace root verificado:** Se `WORKSPACE_ROOT` nao existir na inicializacao, e criado automaticamente (ver tools.md secao 12).

---

## 7. Registro

As tres tools sao registradas no `ToolRegistry` durante o bootstrap (passo 4: "Inicializar ToolRegistry"). O registro e feito via codigo TypeScript - as tools nao sao carregadas do filesystem como skills.

```typescript
// bootstrap (pseudo)
const toolRegistry = new ToolRegistry();
toolRegistry.register(new CriarArquivoTool(workspaceRoot));
toolRegistry.register(new LerArquivoTool(workspaceRoot));
toolRegistry.register(new ListarArquivosTool(workspaceRoot));
```

---

## 8. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| `fs` (Node.js) | Obrigatoria | Nenhuma tool de filesystem funciona. |
| `WORKSPACE_ROOT` (env) | Obrigatoria | Tools recusam qualquer operacao (path base indefinido). |
| `ToolRegistry` | Obrigatoria | Tools nao sao descobertas pelo AgentLoop. |

---

## 9. Open Questions

(Nenhuma - este spec foi criado para resolver o gap.)
