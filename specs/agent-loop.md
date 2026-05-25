# Spec: Agent Loop (Reasoning Engine)

---

## 1. Resumo

O **Agent Loop** é a engrenagem central do GeneriClaw. Ele implementa o padrão ReAct (Reasoning and Acting). É o módulo onde uma ação bruta entra, é submetida ao LLM base (Thought), uma ou mais ferramentas são chamadas (Action+Observation), até um veredito de resposta final ser chegado, repetindo em loop limitado de iterações para evitar impasses de contexto infinito.

---

## 2. Contexto e Motivação

**Problema:**
Um LLM standard responde de forma estática do ponto de vista do seu conhecimento congelado. Para que ele vire um Agente, é preciso que ele receba e aja recursivamente no ambiente que está imersivo a ele.

**Evidências:**
Tentar fazer uma "Mega Prompt" para que ele decida e gere arquivo num take só quase sempre gera inferências sujas e falsas promessas de execução (alucinadas). Ele deve executar uma ferramental real via Loop e aguardar o resultado para só então inferir o fecho.

**Por que agora:**
Precisamos desacoplar a parte de grammy/entrada de dados da parte de processamento puramente sistêmico (Tool calls/Registry).

---

## 3. Goals (Objetivos)

- [ ] G-01: Rodar uma iteração abstrata e agnóstica onde um `LLM` possa fornecer ou uma resposta final legível, ou um Tool Call bem estruturado.
- [ ] G-02: Executar automaticamente o call pelo Factory de tools e repassar a observação como se fosse o usuário (`ToolOutput`) no proximo payload pro LLM.
- [ ] G-03: Parar de forma determinística por um hard limit configurável (ex: 5 interações no MAX_ITERATIONS).
- [ ] G-04: Detectar `outputType` da resposta final do LLM. Se a resposta contiver um bloco de código markdown com extensão de arquivo, `outputType` é `"file"`. Caso contrário, `"text"`. O OutputHandler usa este campo para decidir entre `TextOutputStrategy` e `FileOutputStrategy` (ver telegram-output.md 8.1).

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Completude (Success Rate de ReAct loops) | N/A | 95% encerram antes do teto | Em prod |
| Hard limit triggers | Sem limite | Estoura limpo (Throw Error) nas iterações superadas (>MAX) | Imediato |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Manter sessões abertas suspensas aguardando input do usuário no MEIO de um loop de Agent Loop ativo.
- NG-02: Executar Tools de forma paralela usando workers (as tool calls serão tratadas resolutivamente em cascata Promise-based Node sequencial no escopo da mesma iteração ReAct).

---

## 5. Usuários e Personas

**Módulo Cliente Primário:** O `AgentController`, que invoca o AgentLoop repassando o array de mensagens já montado (system prompt + histórico + input atual) e o provider já resolvido via `ProviderFactory.createWithFallback()`.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O sistema deve suportar iterar sobre a classe `BaseTool` herdada para todas as features disponíveis usando o pattern Registry. | Must | Se o LLM retornar JSON malformado nos argumentos de tool call, o AgentLoop injeta observation de erro e a iteração consome 1 unidade do limite. O LLM tem chance de corrigir na próxima iteração. |
| RF-02 | O Agent Loop deve sempre instanciar uma iteração limitadora e parar a execução quando `current > MAX_ITERATIONS` for verificado. | Must | Uma chamada maliciosa não gera billing infinito. |
| RF-03 | A Observação do ambiente gerada por uma base de Tool (`result.output`) deve sempre retornar pro array de mensagens para a próxima dedução (Thought). | Must | LLM não deve se perder; e não pode pre-anunciar execução. |
| RF-04 | O Agent Loop deve registrar logs detalhados de cada etapa (Thought, Action, Observation) no console para monitoramento. | Must | O desenvolvedor deve conseguir acompanhar o raciocínio do agente em tempo real. |

### 6.2 Fluxo Principal (Happy Path)

1. O AgentController monta o array completo de mensagens (system prompt + histórico + input) e chama `AgentLoop.run(messages, provider, toolRegistry)`.
2. O AgentLoop recebe o array pronto — não adiciona mensagens do banco.
3. LLM infere no array atual e decide a chamada `ToolChoice`.
4. O LLM, guiado pelo system prompt da skill, retorna um tool call para executar "criar_arquivo".
5. Iterator detecta chamada, Factory instancia e preenche com Args do JSON.
6. A Promise da Tool retorna "Arquivo Foo feito!".
7. Injeta resultado na variável observation array como `{ role: "tool", content: "Arquivo Foo feito!" }`. Retorna ao (3) que gera a final response "Usuário, arquivo Foo foi construído!".

### 6.3 Fluxos Alternativos

**Fluxo Alternativo A — Max Iterations Reached:**
1. A IA acha que falta informação ou repete tool call incorreto seguidamente.
2. Contagem do loop alcança o `process.env.MAX_ITERATIONS` (5).
3. O Loop injeta break forçado.
4. Output final vira: "Desculpe, desisti ou deu timeout no processamento pois falhei nas chamadas em MAX iteracoes."

**Fluxo Alternativo B — Falha do Provider (LLM):**
1. `provider.generate()` lança exceção após todos os providers da cadeia de fallback serem esgotados.
2. O AgentLoop captura e propaga a exceção ao AgentController.
3. O AgentController encaminha o erro ao OutputHandler, que notifica o usuario.
4. O AgentLoop nao implementa logica de fallback — o fallback e tratado transparentemente pelo proxy criado por `ProviderFactory.createWithFallback()` antes da chamada ao AgentLoop. O AgentLoop so ve a excecao terminal.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Timeout por iteração unitária LLM | < 120s | Pra evitar socket hang do Node |
| RNF-02 | Timeout por execução de tool | 30s | Aplicado via `Promise.race` no AgentLoop. Tool que excede o tempo tem execução abortada e observation de timeout injetada. |

---

## 8. Design e Interface

### 8.1 AgentLoop

```typescript
class AgentLoop {
  private maxIterations: number;
  private toolFactory: ToolFactory;

  constructor(config: { maxIterations: number; toolFactory: ToolFactory });

  async run(
    messages: LlmMessage[],
    provider: ILlmProvider,
    toolRegistry: ToolRegistry
  ): Promise<AgentLoopResult>;
}
```

### 8.2 Contrato interno

- `run()` recebe o array de mensagens já montado pelo AgentController. Não adiciona mensagens do banco.
- Cada iteração do ReAct consome 1 unidade do limite `maxIterations`, incluindo iterações que resultam em JSON malformado do LLM (EC-01). A resposta de correção do LLM ocorre na iteração seguinte, consumindo outra unidade.
- Quando uma Tool lança exceção (EC-02), o erro é embrulhado como `{ role: "tool", content: "Error: ..." }` e injetado no array de mensagens para o LLM corrigir.
- O AgentLoop chama `provider.generate()` diretamente. O provider recebido ja e o proxy de fallback criado por `ProviderFactory.createWithFallback()`. O proxy absorve falhas de provedores individuais transparentemente. O AgentLoop so captura a excecao terminal (todos os providers esgotados) e a propaga ao Controller.
- Fallback padrão para `maxIterations` quando a variável de ambiente `MAX_ITERATIONS` não está definida: 5.
- `AgentLoopResult.outputType` é determinado pelo AgentLoop com base na resposta final do LLM. Se a resposta contiver um bloco de código markdown com extensão de arquivo (ex: ```markdown /path/file.md), `outputType` é `"file"`. Caso contrário, `outputType` é `"text"`. Skills podem influenciar este comportamento através de seu `systemPrompt` instruindo o LLM a gerar saída em formato de arquivo. O OutputHandler usa este campo para decidir entre `TextOutputStrategy` e `FileOutputStrategy` (ver telegram-output.md 8.1).

**Componentes afetados:** Terminal log-output, Repasse assíncrono pro Output de chat.

---

## 9. Modelo de Dados

Não gera tabelas SQL exclusivas, é stateful em RAM contendo arrays literais durante as interações. No fim, a resposta é entregue para salvar via MemoryManager.

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| ILlmProvider implementations | Obrigatória | Loop principal é interrompido. O AgentLoop propaga a exceção ao Controller. |
| ToolRegistry instanciado | Obrigatória | System prompt ficara vazio / não enxerga braços atuadores. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: JSON Malformado de Argumento da IA | O LLM burla a formatação e entrega string malfeita em vez do schema no ToolCall | Catch no loop e gera Observation pro LLM com `{ role: "tool", content: "JSON inválido, reenvie a estrutura corrigida por favor." }`. Esta iteração consome 1 unidade do limite. |
| EC-02: Ferramenta retorna Throw (Error hard) | Tentou criar num path que não existe na máquina host do Node (`fs.writeFileSync` failure). | O catch embrulha o erro como `{ role: "tool", content: "Error: ENOENT path not exists..." }` e injeta no array de mensagens. O LLM usa essa observation para corrigir o caminho na próxima iteração. |
| EC-03: Max Iteration Limits | Variável de MAX não foi lida do env (null). | Definir fallback pra 5 explicitamente pra não corromper infra. |
| EC-04: Provider (LLM) falha durante o loop | `provider.generate()` lanca excecao apos todos os providers da cadeia de fallback serem esgotados. | O AgentLoop captura e propaga a excecao ao AgentController. O fallback de provider e resolvido pelo `ProviderFactory.createWithFallback()` — o proxy de fallback absorve falhas de provedores individuais transparentemente. O AgentLoop so percebe a falha quando TODOS os providers da cadeia falham. |
| EC-05: Tool excede timeout de execução | `tool.execute()` demora mais de `TOOL_TIMEOUT_MS` (padrão 30s). | AgentLoop aplica `Promise.race` com timeout. Observation injectada: `"Error: Tool execution timed out after 30s."`. Esta iteração consome 1 unidade do limite. |
| EC-06: LLM retorna múltiplos tool calls | Resposta do LLM contém `toolCalls` array com mais de 1 item. | O AgentLoop executa apenas o primeiro tool call. Os demais são ignorados e um warning é logado: `[AgentLoop] LLM returned N tool calls; only the first is executed. Ignored: [tool names].` Esta é uma limitação conhecida (tools.md NG-04). Paralelismo de tools fica para versão 2. |

---

## 12. Segurança e Privacidade

- As Tools são injetadas em prompt - nunca expõe secrets nem paths internos completos que dão base para jailbreak explícito sem sanilização (a Tool deve usar regex no parsing dos envios).

---

## 13. Plano de Rollout

1. Implementar `AgentLoop` com provider mockado e tool factory vazia para teste de iterações.
2. Adicionar suporte a tool calls sequenciais com `ToolFactory` real.
3. Integrar com `ProviderFactory` via `AgentController` (o Controller resolve o provider, o AgentLoop apenas chama `generate()`).
4. Adicionar logs de Thought/Action/Observation.
5. Testar edge cases EC-01 (JSON malformado), EC-02 (tool throw), EC-03 (max iterations).

---

## 14. Open Questions

- Q1: Quantas iterações o LLM típico consome para corrigir um JSON malformado? Se o padrão for 1-2 correções, 5 iterações são suficientes. Se for 3+, o limite precisa ser revisto com dados reais.
- Q2 (Resolvida): RNF-02 já define timeout de 30s por tool via `Promise.race`. Q2 era duplicada. Ver EC-05 para aplicacao do timeout.
