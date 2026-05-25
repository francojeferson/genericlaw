# Spec: Bootstrap / Main Entry Point

---

## 1. Resumo

O módulo de bootstrap é o ponto de entrada da aplicação (`Main.ts`). Ele carrega variáveis de ambiente, inicializa os subsistemas na ordem correta, conecta o bot Grammy ao `AgentController`, e gerencia o encerramento gracioso.

---

## 2. Contexto e Motivação

**Problema:**
architecture.md referencia `App() init()` e `Main.ts` mas nenhum spec define a ordem de inicialização, o tratamento de falhas na partida, ou o wiring entre Grammy e AgentController. Sem isso, cada desenvolvedor implementa a cola de inicialização de forma diferente, e falhas na partida podem corromper o SQLite ou deixar o bot parcialmente funcional sem diagnóstico claro.

**Evidências:**
O PRD e a arquitetura mencionam `npm run dev` como método de inicialização e `AgentController.init()` como ponto de entrada dos subsistemas. A seção de shutdown do agent-controller.md define contrato de `shutdown()` mas não especifica quem captura SIGTERM/SIGINT.

**Por que agora:**
É o primeiro arquivo que um desenvolvedor abre para entender onde o sistema começa. Sem ele, não há ponto de entrada documentado.

---

## 3. Goals (Objetivos)

- [ ] G-01: Definir a função `main()` como ponto único de entrada da aplicação.
- [ ] G-02: Especificar a ordem de inicialização dos subsistemas com validação de dependências.
- [ ] G-03: Conectar o bot Grammy (`Bot` instance) ao `AgentController` via callback de mensagem.
- [ ] G-04: Capturar sinais do SO (SIGTERM, SIGINT) e executar shutdown gracioso.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo de inicialização completa | N/A | < 5s (excluindo download de modelos Whisper) | MVP |
| Falhas na inicialização diagnosticadas | N/A | 100% com log claro do subsistema que falhou | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: O bootstrap não faz hot-reload de código. Isso é responsabilidade do nodemon/tsx no `npm run dev`.
- NG-02: O bootstrap não gerencia processos filhos (Whisper, ffmpeg). Isso é responsabilidade dos módulos que os invocam.

---

## 5. Ordem de Inicialização

A inicialização é sequencial e falha rápido: se um passo falha, os seguintes não são executados e o processo termina com código de erro.

1. **Carregar variáveis de ambiente:** Ler `.env` via `dotenv`. Validar que as variáveis obrigatórias existem (ver `configuration.md`). Se ausentes, logar erro fatal e `process.exit(1)`.
2. **Validar Token do Telegram (pre-flight):** Chamar `bot.api.getMe()` para validar que o `TELEGRAM_BOT_TOKEN` e valido antes de iniciar o polling. Se falhar (token invalido, rede indisponivel), logar erro fatal com a mensagem de erro da API e `process.exit(1)`. Este check detecta tokens invalidos imediatamente, sem esperar pela falha do polling no passo 9. Mantem o handler de erro do polling como defesa em profundidade.
3. **Validar dependências de sistema:** 
   - Verificar presença do binário `ffmpeg` no PATH ou no caminho configurado em `FFMPEG_BINARY` (via `which`/`where`). Se ausente, logar warning: `[Bootstrap] ffmpeg not found — voice input disabled.` — o sistema continua sem entrada de voz, mas nao aborta. Ver telegram-input.md RF-07.
   - Verificar presença do binário `edge-tts` via `edge-tts --version` (child_process). Se ausente, logar warning: `[Bootstrap] edge-tts not found — voice output disabled.` — o sistema continua sem saída de voz, mas nao aborta. Ver telegram-output.md seção 8.3.
   - Verificar presença do binário `whisper` no PATH ou no caminho configurado em `WHISPER_BINARY`. Se ausente, logar warning: `[Bootstrap] whisper not found — voice input disabled.` — o sistema continua sem STT, mas nao aborta. Ver telegram-input.md RF-05.
4. **Inicializar banco de dados:** `await MemoryManager.initialize()`. Cria conexão SQLite, executa PRAGMAs, cria tabelas se não existirem.
5. **Inicializar ToolRegistry:** Registrar todas as tools built-in. Validar schemas.
6. **Inicializar ProviderFactory:** Registrar providers configurados em `LLM_PROVIDERS`. Verificar que as variaveis de ambiente de API key existem para todos os providers na cadeia de fallback. Se ausentes, logar erro fatal e `process.exit(1)`.
7. **Inicializar SkillLoader:** Carregar skills de `agents/skills/`. Validar dependências de tools. O SkillLoader internamente inicia um watcher de arquivos (`fs.watch` ou `chokidar`) na pasta `agents/skills/` para hot-reload, disparando `reload()` automaticamente quando arquivos `SKILL.md` são criados, modificados ou removidos.
8. **Inicializar AgentLoop:** Instanciar com `maxIterations` de `MAX_ITERATIONS` (default 5).
9. **Inicializar AgentController:** Injetar todas as dependências. Chamar `await controller.init()`.
10. **Conectar TelegramInputHandler ao Grammy:** Instanciar `Bot` com token de `TELEGRAM_BOT_TOKEN`. Instanciar `TelegramInputHandler` com dependências (whisper processor, ffmpeg validator). Chamar `telegramInputHandler.start()` que registra os listeners filtrados por tipo de mensagem no Grammy e inicia o polling. Ver telegram-input.md seção 8.2 para o contrato de `start()`.
11. **Registrar handlers de shutdown:** `process.on("SIGTERM", shutdown)` e `process.on("SIGINT", shutdown)`.

---

## 6. Sequência de Shutdown

1. Sinal recebido (SIGTERM ou SIGINT).
2. Log: `[Bootstrap] Shutdown signal received.`
3. `bot.stop()` — para o polling do Telegram.
4. `skillLoader.stopWatcher()` — encerra o watcher de arquivos do hot-reload de skills (ver skill-user.md 8.1).
5. `controller.shutdown()` — fecha o banco de dados e cancela loops pendentes.
6. Log: `[Bootstrap] Shutdown complete.`
7. `process.exit(0)`.

Timeout de segurança: se o shutdown não completar em 10 segundos, `process.exit(1)`.

---

## 7. Requisitos Funcionais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `main()` inicializa todos os subsistemas na ordem definida. | Must | `npm run dev` inicia o bot e ele responde a mensagens. |
| RF-02 | Falha na inicialização de qualquer subsistema obrigatório encerra o processo com código de erro e log específico. | Must | Remover `.env` e iniciar → processo termina com `[Bootstrap] Missing TELEGRAM_BOT_TOKEN` e exit code 1. |
| RF-03 | SIGTERM/SIGINT executa shutdown gracioso. | Must | Ctrl+C fecha o banco sem corromper e para o polling. |
| RF-04 | Timeout de shutdown (10s) força `process.exit(1)`. | Must | Se o banco travar no close, o processo não fica zumbi. |

---

## 8. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: `.env` ausente | Arquivo `.env` não existe. | `dotenv` não lança erro. Mas validação de variáveis obrigatórias falha → log com lista de variáveis faltantes → exit(1). |
| EC-02: DB corrompido | `MemoryManager.initialize()` detecta schema inválido. | MemoryManager aplica estratégia "recriar se inválido" (renomeia .db para .bak, cria novo). Bootstrap loga warning e prossegue. |
| EC-03: API key inválida | Provider retorna 401 na validação. | Bootstrap NÃO valida API keys na inicialização (a validação é lazy, na primeira chamada ao provider). O bootstrap apenas verifica que as variáveis de ambiente existem. |
| EC-04: Grammy falha ao iniciar polling | Rede indisponível ou token inválido. | `bot.start()` lança exceção. Bootstrap captura, loga erro, e chama shutdown. |
| EC-05: Duas instancias competindo pelo mesmo bot token | Outro processo ou maquina esta rodando o GeneriClaw com o mesmo `TELEGRAM_BOT_TOKEN` e fazendo polling no mesmo endpoint. | Guarda tecnica: na inicializacao, o bootstrap cria um arquivo de lock (`./data/genericlaw.lock`) contendo o PID do processo. Se o arquivo ja existir e o PID nele contido corresponder a um processo Node.js vivo (verificado via `process.kill(pid, 0)` no Unix ou `tasklist` no Windows), o bootstrap recusa iniciar e loga: `[Bootstrap] Another instance is already running (PID <pid>). Exiting.` O lock file e removido durante `shutdown()`. Se o processo anterior crashou sem remover o lock, o bootstrap detecta PID morto, loga warning: `[Bootstrap] Stale lock file found (PID <pid> is dead). Removing and proceeding.` e prossegue. |

---

## 9. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| `dotenv` | Obrigatória | Variáveis de ambiente não carregadas → inicialização falha. |
| Grammy `Bot` | Obrigatória | Sem bot, não há interface com Telegram. |
| AgentController | Obrigatória | Central de todo o pipeline. |
| MemoryManager | Obrigatória | Sem persistência, sistema não inicia. |

---

## 10. Plano de Rollout

1. Criar `Main.ts` com função `main()` e ordem de inicialização.
2. Adicionar validação de variáveis de ambiente obrigatórias.
3. Adicionar handlers de SIGTERM/SIGINT.
4. Configurar `npm run dev` para apontar para `Main.ts`.
5. Testar inicialização limpa, inicialização sem .env, e shutdown via Ctrl+C.

---

## 11. Open Questions

(Nenhuma no momento — este spec foi criado para resolver o gap de documentação.)
