# Spec: Bootstrap / Main Entry Point

---

## 1. Resumo

O modulo de bootstrap e o ponto de entrada da aplicacao (`Main.ts`). Ele carrega variaveis de ambiente, inicializa os subsistemas na ordem correta, conecta o bot Grammy ao `AgentController`, e gerencia o encerramento gracioso.

---

## 2. Contexto e Motivacao

**Problema:**
architecture.md referencia `App() init()` e `Main.ts` mas nenhum spec define a ordem de inicializacao, o tratamento de falhas na partida, ou o wiring entre Grammy e AgentController. Sem isso, cada desenvolvedor implementa a cola de inicializacao de forma diferente, e falhas na partida podem corromper o SQLite ou deixar o bot parcialmente funcional sem diagnostico claro.

**Evidencias:**
O PRD e a arquitetura mencionam `npm run dev` como metodo de inicializacao e `AgentController.init()` como ponto de entrada dos subsistemas. A secao de shutdown do agent-controller.md define contrato de `shutdown()` mas nao especifica quem captura SIGTERM/SIGINT.

**Por que agora:**
E o primeiro arquivo que um desenvolvedor abre para entender onde o sistema comeca. Sem ele, nao ha ponto de entrada documentado.

---

## 3. Goals (Objetivos)

- [x] G-01: Definir a funcao `main()` como ponto unico de entrada da aplicacao.
- [x] G-02: Especificar a ordem de inicializacao dos subsistemas com validacao de dependencias.
- [x] G-03: Conectar o bot Grammy (`Bot` instance) ao `AgentController` via callback de mensagem.
- [x] G-04: Capturar sinais do SO (SIGTERM, SIGINT) e executar shutdown gracioso.
- [x] G-05: Falhar no boot, e nao na primeira mensagem, quando nenhum provider configurado pode ser construido.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo de inicializacao completa | N/A | < 5s (excluindo download de modelos Whisper) | MVP |
| Falhas na inicializacao diagnosticadas | N/A | 100% com log claro do subsistema que falhou | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: O bootstrap nao faz hot-reload de codigo. Isso e responsabilidade do nodemon/tsx no `npm run dev`.
- NG-02: O bootstrap nao gerencia processos filhos (Whisper, ffmpeg). Isso e responsabilidade dos modulos que os invocam.

---

## 5. Ordem de Inicializacao

A inicializacao e sequencial e falha rapido: se um passo falha, os seguintes nao sao executados e o processo termina com codigo de erro.

**Principio de ordenacao: o que e barato e local vem antes do que custa rede.** Config, providers e
diretorios sao verificados sem sair da maquina; so depois o processo gasta uma chamada ao Telegram.
Um `.env` com erro de digitacao falha em milissegundos, nao depois de um round-trip.

1. **Carregar e validar variaveis de ambiente:** Ler `.env` via `dotenv`, chamar `validateConfig(process.env)`. Se lancar `ConfigError`, logar e `process.exit(1)` (ver `configuration.md` 3).
2. **Construir e validar os providers de LLM:** `ProviderFactory.createFromConfig(...)`, depois comparar `getNames()` com `[primaryProvider, ...fallbackProviders]`. Se algum nome ficou de fora, logar `[Bootstrap] No usable LLM provider for: <nomes>.` e `process.exit(1)`. Sem esta checagem o bot sobe "saudavel" e responde "Nenhum provedor de IA disponivel." a toda mensagem - um nome fora de `DIRECT_PRESETS` sem `OPENROUTER_API_KEY` e pulado em silencio pela factory (ver `llm-provider.md` 8.2). Em sucesso: `[Bootstrap] Providers registered: <lista>`.
3. **Criar diretorios configurados:** `WORKSPACE_ROOT`, `TMP_DIR` e `SKILLS_DIR`, com `recursive: true`. **Nao se cria `./data`** - o `MemoryManager` cria o diretorio de `DB_PATH` sozinho. Os tres caminhos vem da config: um `./output` fixo aqui faria o workspace configurado nunca ser criado, e `listar_arquivos` falhar com "diretorio nao encontrado" ate o primeiro arquivo nascer.
4. **Validar Token do Telegram (pre-flight):** Instanciar `Bot` e chamar `bot.api.getMe()`. Se falhar (token invalido, rede indisponivel), logar `[Bootstrap] Telegram token validation failed: <msg>` e `process.exit(1)`. Detecta token invalido sem esperar a falha do polling. O handler de erro do polling continua como defesa em profundidade.
5. **Validar dependencias de sistema:** 
   - Verificar presenca do binario `ffmpeg` no PATH ou no caminho configurado em `FFMPEG_BINARY`. O comando de busca e escolhido por plataforma: `where` no Windows, `which` nos demais - `where` nao existe fora do Windows e faria todo binario parecer ausente. Se o valor configurado ja e um caminho (contem separador), a verificacao e feita direto no disco: `where`/`which` so consultam o PATH e reportariam ausente um binario que existe. Se ausente, logar warning: `[Bootstrap] ffmpeg not found - voice input disabled.` - o sistema continua sem entrada de voz, mas nao aborta. Ver telegram-input.md RF-07.
   - Verificar presenca do binario `edge-tts` via `--version` (child_process), usando o caminho de `EDGE_TTS_BINARY`. Se ausente, logar warning: `[Bootstrap] edge-tts not found - voice output disabled.` - o sistema continua sem saida de voz, mas nao aborta. Ver telegram-output.md secao 8.3.
   - Verificar presenca do binario `whisper` no PATH ou no caminho configurado em `WHISPER_BINARY`. Se ausente, logar warning: `[Bootstrap] whisper not found - voice input disabled.` - o sistema continua sem STT, mas nao aborta. Ver telegram-input.md RF-05.
6. **Inicializar banco de dados:** `await memoryManager.initialize()`. Carrega ou cria o banco, executa PRAGMAs e migracoes. Se lancar, logar e `process.exit(1)`.
7. **Inicializar ToolRegistry:** Registrar as tools de filesystem, todas presas a `WORKSPACE_ROOT`.
8. **Inicializar SkillLoader:** Carregar skills de `SKILLS_DIR` e logar quantas. Nao ha watcher de arquivos: o `AgentController` chama `reload()` a cada mensagem, entao o diretorio ja e relido antes de cada turno (ver `skill-user.md` 8.1).
9. **Inicializar SkillRouter e AgentLoop:** O router recebe a `ProviderFactory`; o loop recebe `maxIterations`, `toolTimeoutMs` e `logMessageContent`.
10. **Construir AgentController:** Injetar todas as dependencias no construtor. **Nao ha `init()`** - o construtor so guarda as deps.
11. **Conectar TelegramInputHandler ao Grammy:** Instanciar passando `voiceEnabled: ffmpegAvailable && whisperAvailable` - o resultado das checagens do passo 5 precisa chegar ao handler, caso contrario ele aceita audio que nao tem como processar - e `onShutdown`, um thunk que chama `shutdown()` (declarada adiante; so precisa existir na hora da chamada). `start()` registra os listeners e inicia o polling. Ver telegram-input.md secao 8.2.
12. **Registrar handlers de shutdown:** `process.on("SIGTERM", shutdown)` e `process.on("SIGINT", shutdown)`.

`start()` so resolve quando o polling para, entao o log `[Bootstrap] GeneriClaw is running.` e
emitido **antes** do `await`.

---

## 6. Sequencia de Shutdown

1. Gatilho: `SIGTERM`, `SIGINT` **ou** o comando `/parar` no chat (ver `telegram-input.md`).
2. Guarda de reentrancia: `isShuttingDown` faz chamadas repetidas retornarem na hora.
3. Log: `[Bootstrap] Shutdown signal received.`
4. `inputHandler.stop()` - para o polling do Telegram.
5. `controller.shutdown()` - aguarda as mensagens em voo e fecha o banco.
6. Log: `[Bootstrap] Shutdown complete.`
7. `process.exit(0)`.

Timeout de seguranca: se o shutdown nao completar em 10 segundos, `process.exit(1)`.

**`/parar` agenda o shutdown com `setTimeout(..., 100)` em vez de chama-lo direto.** O shutdown
chama `bot.stop()`, que aguarda os handlers em andamento terminarem - inclusive o proprio handler
do `/parar`. Chamar de dentro dele trava o processo ate o timeout de 10s.

**Em modo `tsx watch`, `/parar` nao encerra o terminal.** Ele mata o processo filho; o supervisor do
`tsx` continua vivo e ressuscita o bot no proximo save em `src/`. Para encerrar de fato em
desenvolvimento, `Ctrl+C`.

**Respostas em voo sao descartadas** no shutdown - ver `agent-controller.md` 6.3 Fluxo C.

---

## 7. Requisitos Funcionais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `main()` inicializa todos os subsistemas na ordem definida. | Must | `npm run dev` inicia o bot e ele responde a mensagens. |
| RF-02 | Falha na inicializacao de qualquer subsistema obrigatorio encerra o processo com codigo de erro e log especifico. | Must | Remover `.env` e iniciar -> processo termina com `[Bootstrap] Missing TELEGRAM_BOT_TOKEN` e exit code 1. |
| RF-03 | SIGTERM/SIGINT executa shutdown gracioso. | Must | Ctrl+C fecha o banco sem corromper e para o polling. |
| RF-04 | Timeout de shutdown (10s) forca `process.exit(1)`. | Must | Se o banco travar no close, o processo nao fica zumbi. |

---

## 8. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: `.env` ausente | Arquivo `.env` nao existe. | `dotenv` nao lanca erro. Mas validacao de variaveis obrigatorias falha -> log com lista de variaveis faltantes -> exit(1). |
| EC-02: DB corrompido | `MemoryManager.initialize()` roda uma consulta de validade (`SELECT 1 FROM sqlite_master`) e ela falha: arquivo cortado ou que nao e um banco SQLite. | MemoryManager aplica estrategia "recriar se invalido" (copia o arquivo para `<dbPath>.bak`, cria um banco novo). Bootstrap loga warning e prossegue. O arquivo nunca e gravado por cima: ver `memory-manager.md` 8.5. |
| EC-03: API key invalida | Provider retorna 401 na primeira chamada real. | O bootstrap **nao** testa autenticidade de chave - isso custaria uma chamada paga por provider. Ele verifica duas coisas baratas: que a variavel existe (`validateConfig`) e que cada nome configurado virou um provider construido (passo 2). Uma chave presente porem invalida so aparece na primeira mensagem. |
| EC-06: Nome de provider sem chave nem preset | `LLM_PROVIDER=foo` sem `OPENROUTER_API_KEY`. | A factory pula `foo` com warning; o passo 2 detecta a ausencia em `getNames()` e encerra com exit 1 citando `foo`. Antes desta checagem o processo subia inteiro e so falhava por mensagem, sem nada no boot apontando a causa. |
| EC-04: Grammy falha ao iniciar polling | Rede indisponivel ou token invalido. | `bot.start()` lanca excecao. Bootstrap captura, loga erro, e chama shutdown. Erro dentro de um handler nao chega aqui: o `bot.catch` do `TelegramInputHandler` o loga e o polling continua (ver `telegram-input.md` 8.2). |
| EC-05: Duas instancias competindo pelo mesmo bot token | Outro processo ou maquina rodando o GeneriClaw com o mesmo `TELEGRAM_BOT_TOKEN`. | **Nao tratado.** O Telegram responde `409 Conflict: terminated by other getUpdates request` a um dos dois, e o polling do grammy fica reclamando em loop. Um arquivo de lock com PID em `./data/` resolveria para instancias na mesma maquina, mas nao para maquinas diferentes, que e o caso que realmente importa; nao foi implementado. Na pratica isso aparece em desenvolvimento, quando o `tsx watch` reinicia antes de o processo anterior soltar o polling, e se resolve sozinho. |

---

## 9. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| `dotenv` | Obrigatoria | Variaveis de ambiente nao carregadas -> inicializacao falha. |
| Grammy `Bot` | Obrigatoria | Sem bot, nao ha interface com Telegram. |
| AgentController | Obrigatoria | Central de todo o pipeline. |
| MemoryManager | Obrigatoria | Sem persistencia, sistema nao inicia. |

---

## 10. Plano de Rollout

Entregue. `src/main.ts` implementa a ordem acima, e `tests/bootstrap-providers.test.ts` a verifica
**executando o processo de verdade** (`npx tsx src/main.ts` com `.env` sobrescrito), lendo o stderr
e o exit code - nao o objeto de config em memoria. Dois casos: um nome de provider impossivel deve
matar o boot citando o nome; um provider valido deve passar da checagem e so morrer no token do
Telegram. O segundo e o controle: sem ele, "o boot falhou" nao provaria nada, porque os dois falham.

Um terceiro caso verifica que os diretorios criados sao os **configurados**, plantando nomes unicos
em `WORKSPACE_ROOT`, `TMP_DIR` e `SKILLS_DIR` e procurando-os no disco depois do boot.

---

## 11. Open Questions

(Nenhuma no momento - este spec foi criado para resolver o gap de documentacao.)
