# Spec: Configuration / Environment Variables

---

## 1. Resumo

Este documento e a fonte unica de verdade para todas as variaveis de ambiente do GeneriClaw. Cada variavel lista tipo, valor padrao, se e obrigatoria, e qual modulo a consome.

---

## 2. Variaveis de Ambiente

### 2.1 Telegram

| Variavel | Tipo | Obrigatoria | Padrao | Modulo Consumidor | Descricao |
|----------|------|-------------|--------|-------------------|-----------|
| `TELEGRAM_BOT_TOKEN` | string | Sim | - | Bootstrap, Grammy Bot | Token do bot Telegram obtido via @BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | string (CSV) | Sim | - | TelegramInputHandler | Lista de user IDs separados por virgula. Ex: `123456789,987654321`. Usuarios fora desta lista, e qualquer chat que nao seja privado, sao ignorados silenciosamente. |

### 2.2 LLM Providers

| Variavel | Tipo | Obrigatoria | Padrao | Modulo Consumidor | Descricao |
|----------|------|-------------|--------|-------------------|-----------|
| `LLM_PROVIDER` | string | Nao | `gemini` | ProviderFactory | Provider primario. Aceita um alias (`gemini`, `deepseek`, `nemotron`, `nemotron-super`) **ou qualquer slug de modelo do OpenRouter**. Ver nota sobre aliases abaixo. |
| `LLM_PROVIDERS` | string (CSV) | Nao | (cadeia vazia) | ProviderFactory | Lista ordenada de providers para fallback. Aceita aliases ou slugs crus. Ex: `gemini,deepseek`. Se vazia, apenas `LLM_PROVIDER` e usado. Espacos ao redor das virgulas sao ignorados - `gemini, deepseek` e equivalente a `gemini,deepseek`. |
| `GEMINI_API_KEY` | string | Condicional | - | GeminiProvider | Obrigatoria se `gemini` estiver em `LLM_PROVIDER` ou `LLM_PROVIDERS`. Mapeamento e explicito e documentado: o provider name usado em `LLM_PROVIDER[S]` corresponde ao sufixo `_API_KEY` - `gemini` -> `GEMINI_API_KEY`, `deepseek` -> `DEEPSEEK_API_KEY`, `groq` -> `GROQ_API_KEY`. |
| `DEEPSEEK_API_KEY` | string | Condicional | - | OpenAiCompatProvider | Obrigatoria se `deepseek` estiver em `LLM_PROVIDER` ou `LLM_PROVIDERS`. |
| `GROQ_API_KEY` | string | Condicional | - | OpenAiCompatProvider | Obrigatoria se `groq` estiver em `LLM_PROVIDER` ou `LLM_PROVIDERS`. |

### 2.3 Agent Loop

| Variavel | Tipo | Obrigatoria | Padrao | Modulo Consumidor | Descricao |
|----------|------|-------------|--------|-------------------|-----------|
| `MAX_ITERATIONS` | number | Nao | `5` | AgentLoop | Numero maximo de iteracoes do ReAct loop por mensagem. Ver 3.2: documentos grandes precisam de mais. |
| `LLM_TIMEOUT_MS` | number | Nao | `120000` | AgentLoop, ILlmProvider | Timeout por requisicao ao LLM em milissegundos (padrao 120s). |
| `LLM_RETRY_COUNT` | number | Nao | `3` | ILlmProvider (withRetry) | Numero maximo de tentativas de retry para erros transientes (429, 503). Alinhado com llm-provider.md secao 6.1 RF-05. |
| `LLM_RETRY_BASE_DELAY_MS` | number | Nao | `1000` | ILlmProvider (withRetry) | Delay base para exponential backoff em milissegundos. Com `LLM_RETRY_COUNT=3` (padrao), sequencia: 1s, 2s, 4s. O valor padrao e 3 - valores diferentes podem ser configurados via `LLM_RETRY_COUNT`. Alinhado com llm-provider.md secao 6.1 RF-05. |
| `TOOL_TIMEOUT_MS` | number | Nao | `30000` | AgentLoop | Timeout por execucao de tool em milissegundos (padrao 30s). |

### 2.4 Memory

| Variavel | Tipo | Obrigatoria | Padrao | Modulo Consumidor | Descricao |
|----------|------|-------------|--------|-------------------|-----------|
| `MEMORY_WINDOW_SIZE` | number | Nao | `20` | MemoryManager | Numero de mensagens recentes carregadas no contexto do LLM. |
| `DB_PATH` | string | Nao | `./data/db.sqlite` | MemoryManager | Caminho para o arquivo do banco SQLite. |
| `DB_MAX_SIZE_MB` | number | Nao | `500` | MemoryManager | Tamanho maximo do arquivo .db antes de `VACUUM` completo. Verificado no boot **e a cada gravacao em disco**. |

### 2.5 Filesystem

| Variavel | Tipo | Obrigatoria | Padrao | Modulo Consumidor | Descricao |
|----------|------|-------------|--------|-------------------|-----------|
| `WORKSPACE_ROOT` | string | Nao | `./output` | Tools (filesystem) | Diretorio base para tools que operam no filesystem. Paths de tool sao resolvidos relativos a este diretorio. Criado automaticamente se nao existir. |
| `TMP_DIR` | string | Nao | `./tmp` | TelegramInputHandler, TelegramOutputHandler | Diretorio para arquivos temporarios (PDF, audio, .md gerados). Arquivos sao deletados apos uso. |
| `SKILLS_DIR` | string | Nao | `./agents/skills` | SkillLoader | Diretorio onde as skills em Markdown sao carregadas. Relido a cada mensagem - nao ha watcher. Criado no boot se nao existir. |

### 2.6 Logging

| Variavel | Tipo | Obrigatoria | Padrao | Modulo Consumidor | Descricao |
|----------|------|-------------|--------|-------------------|-----------|
| `LOG_MESSAGE_CONTENT` | boolean | Nao | `false` | AgentLoop | Quando `false` (padrao), **nenhuma string de argumento de tool sai literal no log** - cada uma vira `<N chars>`. Com `true`, strings ate 80 caracteres aparecem. Ver `agent-loop.md` 8.8 para o unico ponto do codigo que consome a flag. |

### 2.7 Audio (STT/TTS)

| Variavel | Tipo | Obrigatoria | Padrao | Modulo Consumidor | Descricao |
|----------|------|-------------|--------|-------------------|-----------|
| `WHISPER_BINARY` | string | Nao | `whisper` | WhisperProcessor | Nome no PATH **ou caminho completo** para o CLI do whisper.cpp. `npm run setup:whisper` o baixa em `bin/whisper/`. |
| `WHISPER_MODEL` | string | Nao | `small` | WhisperProcessor | Modelo ggml. Valores: `tiny`, `base`, `small`, `medium`, `large`. Resolve para `models/whisper/ggml-<modelo>.bin`. |
| `WHISPER_LANGUAGE` | string | Nao | `pt` | WhisperProcessor | Idioma passado via `--language`. **Obrigatorio na pratica:** sem ele o whisper.cpp assume ingles e *traduz* o audio em vez de transcrever. |
| `TTS_VOICE_ID` | string | Nao | `pt-BR-ThalitaMultilingualNeural` | TelegramOutputHandler | Voz padrao para sintese TTS via Edge-TTS. |
| `EDGE_TTS_BINARY` | string | Nao | `edge-tts` | EdgeTTSProcessor | Nome no PATH ou caminho completo. O `pip` instala fora do PATH no Windows. |
| `FFMPEG_BINARY` | string | Nao | `ffmpeg` | TelegramInputHandler | Nome no PATH ou caminho completo do ffmpeg. |

---

## 3. Regras de Validacao

Na inicializacao, o bootstrap valida:

1. **Variaveis obrigatorias ausentes:** `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ALLOWED_USER_IDS` devem existir. Se ausentes, `process.exit(1)` com log listando as faltantes.
2. **API keys condicionais:** Se `OPENROUTER_API_KEY` estiver presente, ela atende todos os providers e nenhuma chave por provider e exigida. Caso contrario, se `LLM_PROVIDERS` contem `gemini`, `GEMINI_API_KEY` deve existir - mesma logica para deepseek e groq. API keys sao validadas como presentes, nao como validas (validacao de autenticidade e lazy, na primeira chamada ao provider).
3. **Variaveis numericas:** parseadas com `parseInt` e validadas contra um **minimo por chave**. Valor NaN ou abaixo do minimo entra em `invalidKeys` e aborta o boot - nao e silenciosamente substituido pelo padrao.

   | Variavel | Minimo | Por que |
   |----------|--------|---------|
   | `MAX_ITERATIONS` | 1 | Com `0` o loop nunca roda e todo turno devolve a mensagem de desistencia. |
   | `MEMORY_WINDOW_SIZE` | 1 | Com `0`, `deleteOldMessages(id, 0)` apaga a conversa inteira a cada mensagem salva. Perda de dados. |
   | `LLM_TIMEOUT_MS`, `TOOL_TIMEOUT_MS`, `DB_MAX_SIZE_MB` | 1 | Zero significaria timeout imediato ou compactacao continua. |
   | `LLM_RETRY_COUNT`, `LLM_RETRY_BASE_DELAY_MS` | **0** | "Nao tentar de novo" e "sem espera" sao pedidos legitimos. |

4. **Providers utilizaveis:** validado pelo bootstrap, nao por `validateConfig()` - ver `bootstrap.md` 5 passo 2.
5. **Variaveis booleanas:** `LOG_MESSAGE_CONTENT` e `true` se for exatamente `"true"` (case insensitive). Qualquer outro valor e tratado como `false`.
6. **Parse unico:** cada variavel numerica e parseada uma unica vez, antes da checagem de erros, e o valor e reaproveitado na montagem do objeto de config. Parsear de novo depois do `throw` mascara erros de valor.

### 3.2 MAX_ITERATIONS e leitura de documentos grandes

O padrao `5` serve para conversa e para criar/ler arquivos pequenos. **Nao serve para resumir um
documento grande.**

`ler_arquivo` tem teto de 32KB por chamada (ver `core-tools.md` 5.2), entao um documento de ~200KB
exige cerca de 7 leituras, mais as iteracoes de raciocinio entre elas. Com `MAX_ITERATIONS=5` o loop
estoura na metade e o usuario recebe a mensagem de desistencia - depois de ja ter gasto os tokens.
Medido com um PDF de 201KB: 5 iteracoes, 45% do arquivo lido, 72 mil tokens, nenhuma resposta util.

A aritmetica que importa: **resultados de tool se acumulam no contexto do loop**. Paginar nao evita o
custo de um resumo completo, apenas o distribui e acrescenta idas e voltas - cada iteracao reenvia
tudo que veio antes. Um resumo real de 200KB custa dezenas de milhares de tokens em qualquer
configuracao; o que `MAX_ITERATIONS` decide e se ele *termina*.

Orientacao:

- Conversa e arquivos pequenos: `5` basta.
- Documentos grandes: `12` ou mais, aceitando 150-250 mil tokens e 1-2 minutos por pergunta.
- Se esse custo por pergunta for inaceitavel, a solucao estrutural e resumir no momento do upload e
  guardar o resumo junto do texto, em vez de reler o documento a cada pergunta.

### 3.1 Aliases de modelo e slugs crus

O caminho do OpenRouter (`openRouterProvider()`) mantem um mapa pequeno de aliases (`gemini`, `deepseek`, `nemotron`,
`nemotron-super`) para slugs de modelo. Se o nome nao esta no mapa, ele e usado **como slug
diretamente** - entao `LLM_PROVIDER=google/gemma-4-26b-a4b-it:free` funciona sem alteracao de codigo.

Prefira slugs crus. O mapa de aliases e uma lista fixa no codigo e fica obsoleta quando o OpenRouter
remove um modelo do catalogo: dois aliases ja apontaram para modelos descontinuados, produzindo `404`
sem explicacao ate que alguem lesse o fonte.

Armadilhas de custo e disponibilidade ao escolher o modelo:

- Modelos **sem** o sufixo `:free` consomem creditos e retornam `402 Payment Required` com saldo zero.
- Modelos gratuitos sao limitados por taxa (`429`) e retornam `503` quando o fornecedor upstream esta sobrecarregado.
- Por isso, configure sempre uma cadeia de fallback em `LLM_PROVIDERS`.

---

## 4. Arquivo `.env`

Todas as variaveis sao carregadas via `dotenv` do arquivo `.env` na raiz do projeto. O arquivo `.env` NAO e commitado no Git (listado em `.gitignore`).

Exemplo de `.env` minimo:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234gh
TELEGRAM_ALLOWED_USER_IDS=123456789

LLM_PROVIDER=gemini
LLM_PROVIDERS=gemini,deepseek
GEMINI_API_KEY=AIza...
DEEPSEEK_API_KEY=sk-...

MAX_ITERATIONS=5
MEMORY_WINDOW_SIZE=20
WORKSPACE_ROOT=./output
LOG_MESSAGE_CONTENT=true
```

---

## 5. Modulo de Configuracao (Implementacao)

Todas as variaveis sao expostas por um modulo `config.ts` que centraliza a leitura e fornece valores tipados:

```typescript
// src/config.ts
interface AppConfig {
  telegram: {
    botToken: string;
    allowedUserIds: string[];
  };
  llm: {
    primaryProvider: string;
    fallbackProviders: string[];
    apiKeys: Record<string, string>;
    openRouterApiKey?: string;     // quando presente, atende a cadeia inteira
  };
  agent: {
    maxIterations: number;
    llmTimeoutMs: number;
    llmRetryCount: number;
    llmRetryBaseDelayMs: number;
    toolTimeoutMs: number;
  };
  memory: {
    windowSize: number;
    dbPath: string;
    dbMaxSizeMb: number;
  };
  filesystem: {
    workspaceRoot: string;
    tmpDir: string;
    skillsDir: string;
  };
  logging: {
    logMessageContent: boolean;
  };
  audio: {
    whisperBinary: string;
    whisperModel: string;
    whisperLanguage: string;
    ttsVoiceId: string;
    ffmpegBinary: string;
    edgeTtsBinary: string;
  };
}
```

`main.ts` e o unico modulo que le `process.env`, como ponto de entrada que carrega `.env` via
`dotenv` e chama `validateConfig()`. Todos os outros recebem os valores **por injecao de
dependencia** - nao ha import de um objeto global de config.

---

## 6. Contrato do Modulo config.ts

### 6.1 Ordem de Inicializacao

1. `main.ts` chama `dotenv.config()` para carregar o arquivo `.env` da raiz do projeto.
2. `main.ts` chama `validateConfig(process.env)` - funcao pura exportada por `config.ts` que retorna `AppConfig` ou lanca `ConfigError`.
3. A validacao segue as regras da secao 3 deste spec. Se falhar, `process.exit(1)` com log das variaveis faltantes e invalidas.
4. O `AppConfig` retornado ja vem congelado: `Object.freeze(config)` impede mutacao acidental em runtime.
5. `main.ts` injeta o `AppConfig` nos modulos que o consomem.

### 6.2 Cache e Imutabilidade

O `AppConfig` e construido UMA vez na inicializacao. Nao ha releitura de `process.env` apos o bootstrap. O objeto e tratado como imutavel - qualquer tentativa de modifica-lo em runtime e um bug.

### 6.3 Acesso por Modulos

**Ha um unico padrao: injecao de dependencia.** Cada modulo recebe o que precisa pelo construtor -
o `AppConfig` inteiro (`TelegramInputHandler`, `AgentController`) ou apenas os campos relevantes
(`new AgentLoop({ maxIterations, toolTimeoutMs, logMessageContent })`).

Nao existe acesso global. `config.ts` exporta apenas `validateConfig`, `ConfigError` e os tipos.
Houve um singleton `getConfig()`/`setConfig()`/`resetConfig()`: `setConfig()` era chamado no boot,
mas `getConfig()` **nunca** teve chamador, porque tudo ja chegava por injecao. Foi removido.

### 6.4 Estrategia de Teste

- `validateConfig()` e testada como funcao pura: recebe `Record<string, string \| undefined>` e retorna `AppConfig` ou lanca.
- Testes cobrem: ausencia de obrigatorias, API keys condicionais, parse numerico com NaN, parse booleano com valores invalidos.
- Mocks de `process.env` nao sao necessarios - a funcao recebe o objeto explicitamente.
- `AppConfig` em testes de modulos e um objeto literal tipado, nao o resultado de `validateConfig`.

### 6.5 Hot-Reload

`config.ts` NAO suporta hot-reload de variaveis de ambiente. Skills sao relidas a cada mensagem - sem watcher de arquivos (ver `skill-user.md` 8.1). Mudancas em variaveis de ambiente requerem restart do processo.

---

## 7. ConfigError

`ConfigError` e a classe de erro lancada por `validateConfig()` quando variaveis obrigatorias estao ausentes ou invalidas.

```typescript
class ConfigError extends Error {
  readonly missingKeys: string[];    // nomes das variaveis obrigatorias ausentes
  readonly invalidKeys: string[];    // nomes das variaveis com valor invalido

  constructor(message: string, missingKeys: string[], invalidKeys: string[]);
}
```

**Semantica:**
- `missingKeys`: nomes das variaveis de ambiente obrigatorias que estao ausentes ou vazias. Ex: `["TELEGRAM_BOT_TOKEN"]`.
- `invalidKeys`: nomes das variaveis que existem mas tem valor invalido (ex: string onde era esperado numero). Ex: `["MAX_ITERATIONS"]` quando o valor e `"abc"`.
- `message`: descricao legivel listando as chaves faltantes e invalidas.

**Uso:** `bootstrap.ts` captura `ConfigError`, loga `message` no console, e chama `process.exit(1)`. Nenhum tratamento adicional - `ConfigError` e sempre fatal na inicializacao.

---

## 8. Open Questions

(Nenhuma no momento - este spec foi criado para resolver o gap de documentacao.)
