# Spec: Configuration / Environment Variables

---

## 1. Resumo

Este documento é a fonte única de verdade para todas as variáveis de ambiente do GeneriClaw. Cada variável lista tipo, valor padrão, se é obrigatória, e qual módulo a consome.

---

## 2. Variáveis de Ambiente

### 2.1 Telegram

| Variável | Tipo | Obrigatória | Padrão | Módulo Consumidor | Descrição |
|----------|------|-------------|--------|-------------------|-----------|
| `TELEGRAM_BOT_TOKEN` | string | Sim | — | Bootstrap, Grammy Bot | Token do bot Telegram obtido via @BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | string (CSV) | Sim | — | TelegramInputHandler | Lista de user IDs separados por vírgula. Ex: `123456789,987654321`. Usuários fora desta lista são ignorados silenciosamente. |

### 2.2 LLM Providers

| Variável | Tipo | Obrigatória | Padrão | Módulo Consumidor | Descrição |
|----------|------|-------------|--------|-------------------|-----------|
| `LLM_PROVIDER` | string | Não | `gemini` | ProviderFactory | Provider primário. Valores: `gemini`, `deepseek`, `groq`. |
| `LLM_PROVIDERS` | string (CSV) | Não | (cadeia vazia) | ProviderFactory | Lista ordenada de providers para fallback. Ex: `gemini,deepseek`. Se vazia, apenas `LLM_PROVIDER` é usado. Espaços ao redor das vírgulas são ignorados — `gemini, deepseek` é equivalente a `gemini,deepseek`. |
| `GEMINI_API_KEY` | string | Condicional | — | GeminiProvider | Obrigatória se `gemini` estiver em `LLM_PROVIDER` ou `LLM_PROVIDERS`. Mapeamento é explícito e documentado: o provider name usado em `LLM_PROVIDER[S]` corresponde ao sufixo `_API_KEY` — `gemini` → `GEMINI_API_KEY`, `deepseek` → `DEEPSEEK_API_KEY`, `groq` → `GROQ_API_KEY`. |
| `DEEPSEEK_API_KEY` | string | Condicional | — | DeepSeekProvider | Obrigatória se `deepseek` estiver em `LLM_PROVIDER` ou `LLM_PROVIDERS`. |
| `GROQ_API_KEY` | string | Condicional | — | GroqProvider | Obrigatória se `groq` estiver em `LLM_PROVIDER` ou `LLM_PROVIDERS`. |

### 2.3 Agent Loop

| Variável | Tipo | Obrigatória | Padrão | Módulo Consumidor | Descrição |
|----------|------|-------------|--------|-------------------|-----------|
| `MAX_ITERATIONS` | number | Não | `5` | AgentLoop | Número máximo de iterações do ReAct loop por mensagem. |
| `LLM_TIMEOUT_MS` | number | Não | `120000` | AgentLoop, ILlmProvider | Timeout por requisição ao LLM em milissegundos (padrão 120s). |
| `LLM_RETRY_COUNT` | number | Não | `3` | ILlmProvider (withRetry) | Número máximo de tentativas de retry para erros transientes (429, 503). Alinhado com llm-provider.md seção 6.1 RF-05. |
| `LLM_RETRY_BASE_DELAY_MS` | number | Não | `1000` | ILlmProvider (withRetry) | Delay base para exponential backoff em milissegundos. Com `LLM_RETRY_COUNT=3` (padrão), sequência: 1s, 2s, 4s. O valor padrão é 3 — valores diferentes podem ser configurados via `LLM_RETRY_COUNT`. Alinhado com llm-provider.md seção 6.1 RF-05. |
| `TOOL_TIMEOUT_MS` | number | Não | `30000` | AgentLoop | Timeout por execução de tool em milissegundos (padrão 30s). |

### 2.4 Memory

| Variável | Tipo | Obrigatória | Padrão | Módulo Consumidor | Descrição |
|----------|------|-------------|--------|-------------------|-----------|
| `MEMORY_WINDOW_SIZE` | number | Não | `20` | MemoryManager | Número de mensagens recentes carregadas no contexto do LLM. |
| `DB_PATH` | string | Não | `./data/db.sqlite` | MemoryManager | Caminho para o arquivo do banco SQLite. |
| `DB_MAX_SIZE_MB` | number | Não | `500` | MemoryManager | Tamanho máximo do arquivo .db antes de vacuum completo na inicialização. |

### 2.5 Filesystem

| Variável | Tipo | Obrigatória | Padrão | Módulo Consumidor | Descrição |
|----------|------|-------------|--------|-------------------|-----------|
| `WORKSPACE_ROOT` | string | Não | `./output` | Tools (filesystem) | Diretório base para tools que operam no filesystem. Paths de tool são resolvidos relativos a este diretório. Criado automaticamente se não existir. |
| `TMP_DIR` | string | Não | `./tmp` | TelegramInputHandler, TelegramOutputHandler | Diretório para arquivos temporários (PDF, áudio, .md gerados). Arquivos são deletados após uso. |
| `SKILLS_DIR` | string | Não | `./agents/skills` | SkillLoader | Diretório onde as skills em Markdown são carregadas. Hot-reload monitora este diretório. |

### 2.6 Logging

| Variável | Tipo | Obrigatória | Padrão | Módulo Consumidor | Descrição |
|----------|------|-------------|--------|-------------------|-----------|
| `LOG_MESSAGE_CONTENT` | boolean | Não | `false` | AgentLoop, AgentController | Quando `true`, logs DEBUG são liberados. Padrão `false` para evitar expor conteúdo de conversas em produção. Desenvolvedores optam ativamente por `true` quando precisam de logs detalhados. |

### 2.7 Áudio (STT/TTS)

| Variável | Tipo | Obrigatória | Padrão | Módulo Consumidor | Descrição |
|----------|------|-------------|--------|-------------------|-----------|
| `WHISPER_BINARY` | string | Não | `whisper` | TelegramInputHandler | Caminho ou nome do binário Whisper CLI no PATH. |
| `WHISPER_MODEL` | string | Não | `small` | TelegramInputHandler | Modelo Whisper a ser usado. Valores: `tiny`, `base`, `small`, `medium`, `large`. |
| `TTS_VOICE_ID` | string | Não | `pt-BR-ThalitaMultilingualNeural` | TelegramOutputHandler | Voz padrão para síntese TTS via Edge-TTS. |
| `FFMPEG_BINARY` | string | Não | `ffmpeg` | TelegramInputHandler | Caminho ou nome do binário ffmpeg no PATH. |

---

## 3. Regras de Validação

Na inicialização, o bootstrap valida:

1. **Variáveis obrigatórias ausentes:** `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ALLOWED_USER_IDS` devem existir. Se ausentes, `process.exit(1)` com log listando as faltantes.
2. **API keys condicionais:** Se `LLM_PROVIDERS` contém `gemini`, `GEMINI_API_KEY` deve existir. Mesma lógica para deepseek e groq. API keys são validadas como presentes, não como válidas (validação de autenticidade é lazy, na primeira chamada ao provider).
3. **Variáveis numéricas:** `MAX_ITERATIONS`, `LLM_TIMEOUT_MS`, `LLM_RETRY_COUNT`, `LLM_RETRY_BASE_DELAY_MS`, `TOOL_TIMEOUT_MS`, `MEMORY_WINDOW_SIZE`, `DB_MAX_SIZE_MB` são parseadas com `parseInt`. Se NaN, usa o valor padrão e loga warning.
4. **Variáveis booleanas:** `LOG_MESSAGE_CONTENT` é `true` se for exatamente `"true"` (case insensitive). Qualquer outro valor é tratado como `false`.

---

## 4. Arquivo `.env`

Todas as variáveis são carregadas via `dotenv` do arquivo `.env` na raiz do projeto. O arquivo `.env` NÃO é commitado no Git (listado em `.gitignore`).

Exemplo de `.env` mínimo:

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

## 5. Módulo de Configuração (Implementação)

Todas as variáveis são expostas por um módulo `config.ts` que centraliza a leitura e fornece valores tipados:

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
    ttsVoiceId: string;
    ffmpegBinary: string;
  };
}
```

`bootstrap.ts` e a unica excecao que le `process.env` diretamente, como ponto de entrada da aplicacao que carrega `.env` via `dotenv` e valida variaveis obrigatorias. Todos os outros modulos consomem `config.ts` ou recebem os valores via injecao de dependencia.

---

## 6. Contrato do Modulo config.ts

### 6.1 Ordem de Inicializacao

1. `bootstrap.ts` chama `dotenv.config()` para carregar o arquivo `.env` da raiz do projeto.
2. `bootstrap.ts` chama `validateConfig(process.env)` — funcao pura exportada por `config.ts` que retorna `AppConfig` ou lanca `ConfigError`.
3. A validacao segue as regras da secao 3 deste spec. Se falhar, `process.exit(1)` com log das variaveis faltantes.
4. O `AppConfig` validado e congelado: `Object.freeze(config)` impede mutacao acidental em runtime.
5. `bootstrap.ts` injeta o `AppConfig` congelado nos modulos que o consomem diretamente (ex: `new GrammyBot(config.telegram.botToken)`). Modulos que nao recebem injecao importam o objeto congelado diretamente de `config.ts`.

### 6.2 Cache e Imutabilidade

O `AppConfig` e construido UMA vez na inicializacao. Nao ha releitura de `process.env` apos o bootstrap. O objeto e tratado como imutavel — qualquer tentativa de modifica-lo em runtime e um bug.

### 6.3 Acesso por Modulos

Dois padroes de acesso coexistem:

| Padrao | Quando usar | Exemplo |
|--------|-------------|---------|
| Injecao de dependencia | Modulos instanciados no bootstrap que precisam de config tipado | `new TelegramInputHandler(config)` |
| Import direto | Modulos utilitarios, factories, ou modulos profundos onde injecao seria verbose | `import { config } from '../config'` |

Nao ha distincao funcional entre os dois — ambos recebem o mesmo objeto congelado. A escolha e pragmatica: injecao para modulos de primeiro nivel instanciados no bootstrap, import para o resto.

### 6.4 Estrategia de Teste

- `validateConfig()` e testada como funcao pura: recebe `Record<string, string \| undefined>` e retorna `AppConfig` ou lanca.
- Testes cobrem: ausencia de obrigatorias, API keys condicionais, parse numerico com NaN, parse booleano com valores invalidos.
- Mocks de `process.env` nao sao necessarios — a funcao recebe o objeto explicitamente.
- `AppConfig` em testes de modulos e um objeto literal tipado, nao o resultado de `validateConfig`.

### 6.5 Hot-Reload

`config.ts` NAO suporta hot-reload de variaveis de ambiente. Skills suportam hot-reload via `SKILLS_DIR` watcher (definido em `skill-user.md`). Mudancas em variaveis de ambiente requerem restart do processo.

---

## 7. ConfigError

`ConfigError` é a classe de erro lançada por `validateConfig()` quando variáveis obrigatórias estão ausentes ou inválidas.

```typescript
class ConfigError extends Error {
  readonly missingKeys: string[];    // nomes das variaveis obrigatorias ausentes
  readonly invalidKeys: string[];    // nomes das variaveis com valor invalido

  constructor(message: string, missingKeys: string[], invalidKeys: string[]);
}
```

**Semântica:**
- `missingKeys`: nomes das variáveis de ambiente obrigatórias que estão ausentes ou vazias. Ex: `["TELEGRAM_BOT_TOKEN"]`.
- `invalidKeys`: nomes das variáveis que existem mas têm valor inválido (ex: string onde era esperado número). Ex: `["MAX_ITERATIONS"]` quando o valor é `"abc"`.
- `message`: descrição legível listando as chaves faltantes e inválidas.

**Uso:** `bootstrap.ts` captura `ConfigError`, loga `message` no console, e chama `process.exit(1)`. Nenhum tratamento adicional — `ConfigError` é sempre fatal na inicialização.

---

## 8. Open Questions

(Nenhuma no momento — este spec foi criado para resolver o gap de documentação.)
