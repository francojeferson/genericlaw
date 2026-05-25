# Spec: Tool Registry (Ferramentas Executáveis)

---

## 1. Resumo

O Tool Registry é o subsistema que expõe ferramentas executáveis ao Agent Loop. Cada Tool é uma função concreta que o LLM pode invocar via function call estruturado. O Registry mantém o catálogo de ferramentas disponíveis, gera o schema JSON usado no system prompt do LLM, e o ToolFactory instancia a ferramenta correta quando o LLM solicita execução.

---

## 2. Contexto e Motivação

**Problema:**
O Agent Loop precisa de um contrato padronizado para expor capacidades ao LLM. Sem um registry formal, cada ferramenta teria formato de invocação diferente, o system prompt ficaria inconsistente, e adicionar nova tool exigiria mexer no core do loop.

**Evidências:**
Patterns como ReAct e function calling do OpenAI/Anthropic padronizaram o contrato "tool definition JSON" -> "tool call JSON" -> "tool result string". Sem adotar isso de forma explícita, o agente fica frágil.

**Por que agora:**
O Agent Loop (`agent-loop.md`) e a arquitetura (`architecture.md`) já referenciam ToolRegistry, ToolFactory e BaseTool como dependências obrigatórias. A definição formal fecha o gap de documentação e torna o contrato implementável.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir a interface `ITool` com contrato claro de schema, execução e validação.
- [ ] G-02: O `ToolRegistry` deve expor o catálogo completo de tools como array de definições JSON compatível com LLMs.
- [ ] G-03: O `ToolFactory` deve instanciar a tool correta a partir do nome retornado pelo LLM.
- [ ] G-04: Toda tool deve validar seus argumentos contra um schema JSON antes da execução.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tool Calls parseados corretamente | N/A | 100% schemas válidos | MVP |
| Novas tools adicionadas sem alterar core | N/A | Registrar via arquivo único | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: O Registry não é responsável por executar ferramentas. Apenas catalogar e instanciar. A execução é feita pelo Agent Loop.
- NG-02: Ferramentas não fazem acesso direto ao banco de dados. Se precisarem de persistência, recebem dependências via injeção.
- NG-03: Não implementaremos sandboxing de runtime (chroot/container). Ferramentas executam com as mesmas permissões do processo Node.
- NG-04: Tool calls paralelas (batch) não são suportadas. O ReAct é sequencial — apenas a primeira tool call de cada resposta do LLM é executada. Se o LLM retornar múltiplos tool calls em uma única resposta, o AgentLoop executa apenas o primeiro e ignora os demais, logando warning: `[AgentLoop] LLM returned N tool calls; only the first is executed. Ignored: [tool names]`. Paralelismo fica para versão futura.

---

## 5. Usuários e Personas

**Usuário primário:** O Agent Loop, que consulta o Registry para montar o system prompt e usa o Factory para instanciar tools solicitadas pelo LLM.

**Usuário secundário:** O desenvolvedor, que registra novas tools extendendo `BaseTool`.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `ITool` deve expor: `name: string`, `description: string`, `parameters: JSONSchema`, `execute(args): Promise<ToolResult>`. | Must | Qualquer classe implementando ITool é registrável no Registry. |
| RF-02 | `ToolRegistry.register(tool)` adiciona a tool ao catálogo interno. | Must | Após registro, `getToolDefinitions()` inclui a nova tool no array. |
| RF-03 | `ToolRegistry.getToolDefinitions()` retorna array no formato OpenAI function definitions. | Must | O output é um array de objetos com `name`, `description`, `parameters` válido para injeção no system prompt. |
| RF-04 | `ToolFactory.create(name)` retorna a instância da tool registrada com o nome exato. | Must | Criar tool inexistente lança erro tratável pelo Agent Loop. |
| RF-05 | `BaseTool.validateArgs(args)` valida os argumentos contra o `parameters` schema antes da execução. | Must | Args inválidos retornam erro estruturado, não são passados à execução. |
| RF-06 | `ToolResult` contém `{ success: boolean, output: string, error?: string }`. | Must | O Agent Loop usa `output` como Observation no próximo passo ReAct. |

### 6.2 Fluxo Principal (Happy Path)

1. Na inicialização, o sistema registra todas as tools disponíveis no `ToolRegistry`.
2. O **AgentController** chama `registry.getToolDefinitions()` durante a montagem do system prompt (ver agent-controller.md seção 6.2 passo 7). O AgentLoop NÃO chama `getToolDefinitions()` — ele recebe o array de mensagens já montado com as definições de tools inclusas.
3. O LLM retorna um tool call: `{ name: "criar_arquivo", arguments: { path: "...", content: "..." } }`.
4. O Agent Loop chama `ToolFactory.create("criar_arquivo")`.
5. A tool valida os argumentos via `validateArgs(arguments)`.
6. O Agent Loop executa `tool.execute(arguments)` e recebe `ToolResult`.
7. O `output` do ToolResult é injetado como Observation no próximo passo do ReAct.

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A — Tool não encontrada:**
1. LLM solicita tool `"enviar_email"` que não está registrada.
2. `ToolFactory.create("enviar_email")` lança erro.
3. Agent Loop captura e injeta observation: "Tool 'enviar_email' não disponível. Ferramentas disponíveis: [lista]".

**Fluxo Alternativo B — Argumentos inválidos:**
1. LLM envia `{ arguments: { filename: 123 } }` onde schema espera string.
2. `validateArgs` retorna erro de tipo.
3. Observation: "Argumento 'filename' inválido: esperava string, recebeu number. Corrija e reenvie."
4. LLM tem chance de corrigir na próxima iteração.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Tempo de instanciação | < 5ms | Factory.create é síncrono. |
| RNF-02 | Isolamento de erros | 100% | Falha em uma tool não derruba o Registry nem outras tools. |

---

## 8. Design e Interface

### 8.1 Interface ITool

```typescript
interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;  // para type: "object"
  items?: ToolParameter;  // para type: "array"
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

interface ITool {
  readonly definition: ToolDefinition;
  validateArgs(args: Record<string, unknown>): { valid: boolean; errors?: string[] };
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
```

### 8.2 Classe ToolRegistry

```typescript
class ToolRegistry {
  private tools: Map<string, ITool> = new Map();

  register(tool: ITool): void;
  getToolDefinitions(): ToolDefinition[];
  getToolNames(): string[];
  has(name: string): boolean;
}
```

### 8.3 Classe ToolFactory

```typescript
class ToolFactory {
  constructor(private registry: ToolRegistry) {}
  create(name: string): ITool;  // lança se não existir
}
```

### 8.4 Classe BaseTool

```typescript
abstract class BaseTool implements ITool {
  abstract readonly definition: ToolDefinition;
  abstract execute(args: Record<string, unknown>): Promise<ToolResult>;

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors?: string[] };
}
```

---

## 9. Modelo de Dados

Não gera tabelas SQLite. O Registry é stateful em RAM. As definições de tool são injetadas via código (classes TS), não serializadas.

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| Agent Loop | Consumidor | Sem Agent Loop, as tools não são invocadas. |
| Filesystem (`fs`) | Opcional | Tools que escrevem arquivos precisam de acesso FS. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Tool duplicada | Duas tools registradas com mesmo nome. | `register()` substitui silenciosamente a anterior. Loga warning no console. |
| EC-02: Tool lança exceção não tratada | Erro de runtime dentro de `execute()`. | Agent Loop captura, embrulha como ToolResult com `success: false` e `error` preenchido. |
| EC-03: Schema parameters malformado | Tool registrada com schema que não segue JSON Schema Draft 7. | Validação de schema na inicialização. Ferramenta com schema inválido é rejeitada no register com erro claro. |
| EC-04: Execução excede timeout | Tool demora > 30s. | Agent Loop aplica timeout via `Promise.race`. Observation indica timeout. |

---

## 12. Segurança e Privacidade

- **Validação de entrada:** Toda tool deve validar argumentos antes de executar. Isso previne injeção de paths, comandos ou dados maliciosos via LLM.
- **Sanitização:** Ferramentas que operam no filesystem devem resolver paths relativos contra o diretório base `WORKSPACE_ROOT` (definido via variável de ambiente, padrão `./output`). Paths absolutos ou com `..` são recusados. O diretório base é verificado na inicialização da tool — se não existir, é criado automaticamente.
- **Segredos:** Ferramentas não têm acesso direto a variáveis de ambiente ou secrets. Dependências sensíveis são injetadas pelo construtor.

---

## 13. Plano de Rollout

Implementação em três etapas:
1. Definir interfaces e classes base (ToolRegistry, ToolFactory, BaseTool).
2. Registrar as tools iniciais (filesystem: criar_arquivo, ler_arquivo, listar_arquivos).
3. Integrar com Agent Loop para montagem de system prompt e execução.

---

## 14. Open Questions

- Q1 (Resolvida): Não. Registro de ferramentas é feito apenas na inicialização. Ferramentas não podem registrar outras ferramentas dinamicamente.
- Q2 (Resolvida): Validação manual (zero dependências). O schema usado pelas tools é simples (tipos primitivos, required, enum). Uma função `validateArgs` de ~50 linhas cobre todos os casos sem adicionar ~150KB (ajv) ou ~50KB (zod) ao bundle. Se futuras tools exigirem schemas complexos (anyOf, $ref, pattern), zod pode ser reconsiderado.
