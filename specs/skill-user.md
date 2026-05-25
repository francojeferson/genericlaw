# Spec: Skill Management System (Hot-Reload)

---

## 1. Resumo

A arquitetura de injecao de habilidades (`Skills`) possibilita que novas capacidades, prompts engessados ou guias instrucionais complexos se integrem dinamicamente ao agente sem requerer nenhuma reinicializacao (deploy zero). Atraves deste sistema (Loader -> Router), cada subpasta vira uma Action especializada reconhecida por um LLM.

---

## 2. Contexto e Motivacao

**Problema:**
Adicionar habilidades num chatbot em nivel de codigo causa quebras de estabilidade, misturas no "Core" Principal e requer reboot do backend Node a cada alteracao pequena na string de inteligencia.

**Evidencias:**
Se o LLM receber instrucoes enormes fixas no seu Master Prompt, alem de "queimar dinheiro" com a Context Window cheia em conversas bobas (ex: "Oi"), ele sofre de perda de atencao nas diretivas essenciais. 

**Por que agora:**
A separacao num formato plugin (pasta .agents) modulariza tudo e deixa o Router LLM usar um prompt barato para dizer "Sim, devo focar a Skill de Github" so quando o usuario pedir pra ver repositorios.

---

## 3. Goals (Objetivos)

- [ ] G-01: Ler na raiz do projeto o diretorio `agents/skills` mapeando seus `SKILL.md`. O agente deve, obrigatoriamente, carregar todas as skills desta pasta para formatar e responder adequadamente ao usuario via Telegram.
- [ ] G-02: Executar um Router inicial ("Passo Zero" na rede neural) apenas passando descritivos basicos das Skills + Intencao do usuario, recebendo a string correspondente de qual plugin instanciar ou nulo.
- [ ] G-03: Inserir a documentacao detalhada da Skill no Master Context apenas durante a iteracao daquele comando isolado (Runtime Injection).

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempos Re-escrita Hot Reload | Reboot forcado | 1ms por chamada (FS lendo sincrono subpastas) | Constante |
| Taxa de Sucesso Router LLM | < 50% sem Router | 99% precisao ao acionar o plugin certo | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Chamar multiplas Skills distintas como resposta a uma unica requisicao. Uma requisicao = Uma intencao master / skill principal repassada em pipeline. Multiplos acionamentos serao responsabilidade da abstracao da LLM no passo 2 de ReAct e nao no Router.

---

## 5. Usuarios e Personas

**Usuario Primario:** Generic, atraves da pasta Filesystem para inserir diretorios customizados com `.md`, e o bot interno (Loader e Router) para lidar nos backgrounds da arquitetura.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `SkillLoader` deve abrir sincrono FS nativo na inicial de todas requests Telegram, e carregar **todas** as skills presentes na pasta `agents/skills` para o array. | Must | Retorna Array contendo objetos do YAML frontmatter de nome + desc de todas as pastas de skills instaladas em `agents/skills`. |
| RF-02 | O Prompt de `SkillRouter` deve conter o schema JSON forcado dizendo que ele apenas retorna `{"name": "xyz" | null}`. O campo `name` no JSON de resposta corresponde diretamente ao campo `name` da interface `SkillManifest`. Nenhuma transformacao de nomenclatura e necessaria. | Must | String parse error capturada e tratada igual a nulo (Fallback a chatbot casual). |
| RF-03 | A Observacao "availableSkills" com os resumos enxutos deve ir apenas na primeira iteracao do ReAct loop, nao em todas. | Must | Se o AgentLoop do ReAct nao souber das existencias de Ferramenta da propria skill, quebra por Prompt Injection de seguranca reversa. A catalogacao de skills e estatica durante um loop — enviar em toda iteracao desperdica tokens sem beneficio. |

### 6.2 Fluxo Principal (Happy Path)

1. Entrada: "Crie a spec de auth do projeto React".
2. Evento interceptado. Loader le 3 Skills (PrdManager, GitManager, CodeAnalyzer) de metadado.
3. SkillRouter faz uma chamada LLM usando o mesmo provider configurado (via `ProviderFactory.createWithFallback()`), passando apenas os metadados das skills ("codeAnalyzer", "prdManager") e a intencao do usuario para selecionar a skill correta. O router nao referencia um provider especifico (como Groq) — usa o pipeline de providers configurado em `LLM_PROVIDERS`.
4. O `Router` retorna `{"name": "prd-manager"}`. O campo `name` no JSON de resposta mapeia diretamente para `SkillManifest.name` — nenhuma transformacao de nomenclatura e necessaria.
5. SkillLoader le o arquivo completo de `/prd-manager/SKILL.md` e extrai o system prompt detalhado da skill.
6. Repassa ela no AgentLoop via param `skillContent` (joga no System Role puro) associado a array de ferramentas ativas.
7. Bot devolve arquivo gerado baseando nos parametros intensivos estipulados no SDD local e descarta a string gigante. Limpo o ambiente pro proximo call nao relacionado (como "Que horas sao").

### 6.3 Fluxos Alternativos

**Nenhum Casamento (N/A Intent):** Se perguntou "Como ta a rua ai?" o router em passo zero dira null; fallback cai pro agente raiz responder livre.

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Velocidade de FS IO | Leitura via cache Buffer | Node tem que ler rapido (Fs module nativo, sync tolerado). |

---

## 8. Design e Interface

### 8.1 SkillLoader

```typescript
class SkillLoader {
  private watcher: fs.FSWatcher | null;

  constructor(skillsDir: string, toolRegistry: ToolRegistry);

  loadAll(): SkillManifest[];
  reload(): SkillManifest[];  // hot-reload sem restart
  stopWatcher(): void;        // encerra o watcher de arquivos durante shutdown
}
```

`loadAll()` le o diretorio `skillsDir`, varre subpastas procurando `SKILL.md`, extrai YAML frontmatter de cada uma, e retorna array de `SkillManifest`. Skills sem `SKILL.md` ou com frontmatter invalido sao ignoradas com warning. Apos a leitura inicial, `loadAll()` inicia um watcher de arquivos (`fs.watch` ou `chokidar`) no diretorio `skillsDir` que detecta criacao, alteracao e remocao de arquivos `.md` e chama `reload()` automaticamente. O watcher e interno ao `SkillLoader` — nem o `AgentController` nem o `bootstrap` precisam gerencia-lo diretamente.

`reload()` reexecuta a leitura completa do diretorio e retorna o array atualizado. E chamado internamente pelo watcher de arquivos.

`stopWatcher()` encerra o watcher de arquivos. Deve ser chamado durante o shutdown do sistema (ver `bootstrap.md` secao 6). Se o watcher nao foi iniciado (ex: `skillsDir` nao existe), o metodo e no-op.

### 8.2 SkillRouter

```typescript
class SkillRouter {
  constructor(providerFactory: ProviderFactory);

  async route(userContent: string, availableSkills: SkillManifest[]): Promise<string | null>;
}
```

`route()` faz uma chamada LLM usando `providerFactory.createWithFallback()`, passando apenas os metadados das skills (name, description) e a intencao do usuario. Retorna o `name` da skill selecionada ou `null` se nenhuma skill for relevante. Se o LLM retornar JSON invalido, trata como `null` (fallback para chatbot casual).

**Prompt template do SkillRouter:**

O system prompt enviado ao LLM para roteamento tem o seguinte formato:

```
You are a skill router. Given a user message and a list of available skills, determine which skill (if any) should handle this message.

Available skills:
- <skill1.name>: <skill1.description>
- <skill2.name>: <skill2.description>

Rules:
1. Return ONLY a JSON object with the shape {"name": "<name>"} or {"name": null}.
2. Select a skill only if the user message clearly relates to its description.
3. If no skill is relevant, return {"name": null}.
4. Do NOT include any text outside the JSON object.
5. Do NOT explain your reasoning.
```

O user message é o `content` extraído do `ProcessedInput`. A lista de available skills é gerada a partir do array de `SkillManifest` (campo `name` e `description` de cada skill). O router usa `temperature=0` para roteamento determinístico.

### 8.3 SkillManifest

```typescript
interface SkillManifest {
  name: string;         // identificador unico da skill (ex: "prd-manager")
  description: string;  // descricao curta para o router (ex: "Gera documentos de PRD")
  version: string;      // semver (ex: "1.0.0")
  requires: string[];   // nomes de tools requeridas (ex: ["criar_arquivo"])
  systemPrompt: string; // conteudo completo do SKILL.md apos o frontmatter
}
```

Componente afeta `TelegramOutputHandler` pois a Saida da Skill se for `.md` renderizado no OutputHandler gerara Files (`InputFile({path})`). O front-end invisivel deve exportar um Document puro sem perda das sintaxes e indentacoes.

---

## 9. Modelo de Dados

Nao gera tabela SQLite. Leitura via YAML Frontmatter.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| Parser YAML via regex (`/^---\n([\s\S]*?)\n---/`) | Obrigatoria | Sem parser, nao separo os params frontmatter do markdown e quebra indexacao no array. Regex e suficiente para o YAML plano usado (apenas chave-valor e listas simples). `js-yaml` nao sera usado — ~120KB economizados no bundle. |
| Filesystem Core Node (`fs`) | Obrigatoria | Skill Loader System paralisa em exception de path inexiste `ENOENT`. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Skill Duplicada e Conflitante | O User salvou duas pastas com id "code-maker" iguais no YAML. | Skills sao ordenadas alfabeticamente por nome de pasta apos leitura do filesystem. Se duas pastas tem o mesmo campo `name` no YAML, a ultima na ordem alfabetica substitui a anterior. Warning logado: `[SkillLoader] Duplicate skill name 'code-maker' — using <pasta2>, ignoring <pasta1>.` |
| EC-02: `SKILL.md` Ausente na subpasta | User criou a pasta mas nao colocou spec. | O Loader nao quebra. Pula forEach nativa e silencia falha do plugin na pasta "ghost". |
| EC-03: Falha Estrutural do Frontmatter | Arquivo MD comeca direto no # Header sem `---` tags e sem "name: x" | Rejeita load pontual por null exceptions geradas. Sem log fatal, prosseguir pros demais plugins. |

---

## 12. Fronteira Skill vs Tool

Skills e Tools sao conceitos distintos com responsabilidades separadas:

**Skill:** Define o que o agente sabe fazer em alto nivel. E um documento Markdown com system prompt detalhado que orienta o LLM sobre um dominio especifico. Skills sao carregadas do filesystem (`agents/skills/`), tem hot-reload, e sao injetadas no system prompt durante a iteracao relevante. Skills sao passivas — elas instruem, mas nao executam codigo.

**Tool:** Define uma funcao executavel que o agente pode invocar. E uma classe TypeScript registrada no `ToolRegistry` (ver `tools.md`). Tools sao ativas — executam codigo, acessam filesystem, fazem chamadas de rede.

**Relacao:** Uma Skill pode DEPENDER de Tools, mas nao as DEFINE. Exemplo: a skill `prd-manager` depende da tool `criar_arquivo` para gerar documentos.

**Declaracao de dependencia:** A dependencia e declarada no YAML frontmatter do `SKILL.md` usando o campo `requires`:

```yaml
---
name: prd-manager
description: Gera documentos de PRD a partir de requisitos
version: 1.0.0
requires:
  - criar_arquivo
  - ler_arquivo
---
```

O `SkillLoader` cruza a lista `requires` com o `ToolRegistry` na inicializacao. Se uma tool referenciada nao estiver registrada, o SkillLoader emite warning: `Skill 'prd-manager' requires tool 'criar_arquivo' which is not registered.` A skill carrega normalmente — o LLM simplesmente nao conseguira invocar a tool ausente.

**Registro de Tools por Skill:** Skills nao registram tools diretamente. Tools sao registradas no codigo (arquivos `.ts`) na inicializacao do sistema. Isso mantem a separacao: conteudo (skills em markdown) e hot-reloadable sem reboot; codigo (tools em TypeScript) requer restart.

**Fluxo completo:** Usuario pergunta algo -> SkillRouter seleciona skill -> SkillLoader carrega o system prompt da skill -> AgentLoop monta o prompt completo com tools do ToolRegistry + skill content -> LLM decide qual tool chamar -> ToolFactory instancia e executa -> resultado volta ao LLM -> resposta final.

---

## 13. Seguranca e Privacidade

- Autenticacao e Autorizacao estao em camada externa (Bot Grammy Handler), as skills operam blindly sem verificar Whitelist - assumindo permissao plena concedida globalmente ao AgentController via Telegram UserId check.

---

## 14. Plano de Rollout

A estrutura do diretorio `agents/skills` se tornara o padrao oficial na branch v2 MVP (sem dependencia de banco de dados e so File IO de arquivos markdown normais compativeis com LLMs de leitura de codebase puras e agentes IDE cursor-like).

---

## 15. Open Questions

- Q1 (Resolvida): Apenas primeira iteracao. RF-03 atualizado: "apenas na primeira iteracao do ReAct loop, nao em todas." A catalogacao de skills e estatica durante um loop — enviar em toda iteracao desperdica tokens sem beneficio.
- Q2 (Resolvida): Ordenacao alfabetica por nome de pasta apos leitura do filesystem. Se duas pastas tem o mesmo `name`, a ultima na ordem alfabetica substitui. EC-01 atualizado com este comportamento deterministico.
- Q3 (Resolvida): Regex parse e suficiente. `js-yaml` removido das dependencias. YAML frontmatter usado e plano (chave-valor, listas simples). Regex `/^---\n([\s\S]*?)\n---/` + parse linha-a-linha resolve sem adicionar ~120KB ao bundle.
- Q4 (Design note): SkillRouter (secao 6.2) faz uma chamada LLM extra toda mensagem, dobrando custo e latencia. Para o MVP, isso e aceito como tradeoff de precisao de roteamento. Com precos atuais (~$0.15/1M tokens input, ~$0.60/1M tokens output para Gemini 2.0 Flash), o custo adicional do roteamento e estimado em aproximadamente $0.05 por 1000 mensagens — desprezivel para baixo volume, mas significativo em escala. Versao 2 deve considerar roteamento heuristico primario (keyword/prefix matching) com LLM routing como fallback apenas para mensagens ambiguas.
