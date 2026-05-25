# Spec: Telegram Output Handler

---

## 1. Resumo

O módulo de Output atua como a boca do GeneriClaw. Ele capta o Output resultativo estático final da Pipeline (do Agent Loop ou das Skills puras processadas) e define as estratégias adequadas de exibição — seja "Chunking" em mensagens grandes de texto, seja disparo de documentos em markdown ou aviso explícito de timeout e erro com formatações de emoji.

---

## 2. Contexto e Motivação

**Problema:**
LLMs (como GPT-4 e Gemini) são programados para gerar outputs massivos de 10k-30k tokens em documentações contínuas e códigos densos. O Telegram tem um hard limit restrito de `4096` caracteres por bolha de mensagem. Um envio direto em texto estoura a API (Erro HTTP 400 Payload Too Large). Além disso, documentos gerados na pipeline em JSON ou Markdowns complexos não devem ser "espremidos" em caixas de chat estreitas.

**Evidências:**
Usuários frequentemente pedem por exemplo 3 mil linhas de TCC, que o LLM gera, mas o Agent morreria no Output sem dividir.

**Por que agora:**
A padronização das outputs de Skills requer renderizar os "arquivos" processados na ponta pra uso (salvar e baixar). Sem um output strategy bem definido, a UX morre no console log ou crashea a aplicação final.

---

## 3. Goals (Objetivos)

- [ ] G-01: Prover interface `TelegramOutputHandler` para separar preocupações de Output.
- [ ] G-02: Receber strings > 4096 docs em `TextOutputStrategy` sendo recortadas dinamicamente sem matar a sintaxe ou palavras ao meio, enviando de forma serial múltipla.
- [ ] G-03: Receber tags classificadoras "ARQUIVO.MD" pelo interpretador via regex e encapsular o envio como `FileOutputStrategy` enviando um Attach de arquivo local limpo para o Telegram Document do Usuário.
- [ ] G-04: Prover `AudioOutputStrategy` para sintetizar texto em voz (TTS) via Microsoft Edge TTS quando a flag de áudio for detectada no Pipeline.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Payload de API Error (4096 bytes ext.) | Alto Risco | 0 Crash de Length | MVP |
| Taxa de Conversão Artefatos para Arquivos | N/A | 100% em .md Skills | Continuo |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Não implementaremos botões de inline HTML/CSS no Telegram (Keyboard buttons de sim/nao para o AgentLoop - interface apenas command-line/chat pura simplista inicial).
- NG-02: MarkdownV2 nativo super restritivo (Que exige escape de `()`, `-`, `!` etc). O LLM falha ao escapar nativamente. Usaremos texto formatado cru seguro e legível de fallback.

---

## 5. Usuários e Personas

**Usuario:** Generic, via aplicativo de Telegram que se beneficia de uma Timeline dividida limpa pra leitura dos relatórios com suporte a baixar em .MD suas specs, PRDs etc.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O TextOutputStrategy deverá fatiar strings se e apenas se a string global ultrapassar o limite de caracteres configurado. | Must | Strings de 9000 caracteres criam 3 bolhas limpas sendo enviadas de forma sequencial via loop `for...of` com `await`, garantindo ordem cronológica estrita de chegada ao usuário. O tamanho do chunk é definido pela constante `CHUNK_SIZE` (padrão: 4000 caracteres). O limite do Telegram é 4096 caracteres por mensagem (não bytes). A margem de 96 caracteres previne estouro com emojis e caracteres multibyte. |
| RF-02 | O FileOutputStrategy deve interceptar a flag de envio em arquivo de Markdown e salvar temporariamente no Node pra usar Upload de buffer grammy `replyWithDocument()`. | Must | Geração de documento na Skill envia um anexo com Titulo formatado apropriadamente. |
| RF-03 | O ErrorOutputStrategy formata em bloco emoji amarelo e dispara apenas avisos. | Must | Erros críticos de Prompt/API disparam "⚠️ Erro: X" ao invés de quebra silenciosa no Nodejs. |
| RF-04 | O AudioOutputStrategy deve sintetizar o texto em áudio `.ogg` e enviar como mensagem de voz (`replyWithVoice`) caso a flag `requiresAudioReply` esteja ativa no resultado. | Must | Recebimento de áudio no Telegram em substituição ao texto puro. |

### 6.2 Fluxo Principal (Happy Path)

1. Pipeline AI retornou conteúdo com flag `requiresAudioReply: true`.
2. Output Handler aciona `AudioOutputStrategy`.
3. Sistema sinaliza `record_voice` no Telegram.
4. Texto é limpo de Markdown e enviado para o CLI `edge-tts` (Python) via child_process.execFile.
5. Buffer de áudio resultante é salvo temporariamente no `./tmp/`.
6. Bot envia o arquivo como Voice Note e deleta o arquivo temporário em seguida.

### 6.3 Fluxos Alternativos

Falhas - ver seção de Edge Cases.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Ordem das Mensagens (Sync) | 100% Cronologico | Chunks mal organizados perdem sentido. Async/Await estrito no "for...of" loop em vez de map() promise async. |

---

## 8. Design e Interface

### 8.1 TelegramOutputHandler (Facade)

O `TelegramOutputHandler` é o facade que o `AgentController` chama. Ele encapsula o `GrammyContext` e delega para a estratégia correta.

```typescript
class TelegramOutputHandler {
  private strategies: Map<string, OutputStrategy>;
  private ctx: GrammyContext;
  private edgeTTS: EdgeTTSProcessor;
  private eventEmitter: EventEmitter;

  constructor(ctx: GrammyContext, config: OutputHandlerConfig);

  async send(conversationId: string, result: AgentLoopResult): Promise<void>;
  async sendError(conversationId: string, error: Error): Promise<void>;
}
```

**Contrato de eventos (EventEmitter):**

O `TelegramOutputHandler` emite eventos para notificar o `AgentController` sobre condições assíncronas detectadas durante o envio. O eventEmitter é injetado via constructor e compartilhado com o Controller.

| Evento | Emitido por | Escutado por | Payload | Gatilho |
|--------|------------|-------------|---------|---------|
| `userBlocked` | TelegramOutputHandler.send() | AgentController | `{ conversationId: string }` | Erro 403 "Forbidden: bot was blocked by the user" ao chamar `ctx.reply()` |

**`send(conversationId, result)`:**
1. Seleciona a estratégia baseada em `result.requiresAudioReply` e `result.outputType`.
2. Se `result.outputType === "file"` → `FileOutputStrategy`.
3. Se `result.requiresAudioReply === true` e Edge-TTS disponível → `AudioOutputStrategy`.
4. Caso contrário → `TextOutputStrategy`.
5. Delega `strategy.send(this.ctx, result)`.
6. Se a estratégia lançar erro 403 "Forbidden", emite `this.eventEmitter.emit("userBlocked", { conversationId })`.

**`sendError(conversationId, error)`:**
1. Extrai mensagem segura do erro (sem stack traces, paths, ou API keys).
2. Formata com prefixo de emoji ⚠️.
3. Envia via `ctx.reply()`.
4. Não expõe dados internos.

### 8.2 OutputStrategy Interface

```typescript
interface OutputStrategy {
  send(ctx: GrammyContext, result: AgentLoopResult): Promise<void>;
}
```

### 8.3 EdgeTTSProcessor (TTS)

Responsavel pela sintese de texto em audio via Microsoft Edge TTS. Consumido pelo `AudioOutputStrategy`.

**Instalação:** Edge-TTS é um pacote Python (`edge-tts`) instalado via pip. É uma dependência OPCIONAL de sistema — se não estiver instalado, TTS é desabilitado e o OutputHandler faz fallback para texto.

```bash
pip install edge-tts
```

**Validação de disponibilidade:** Na inicialização, o `EdgeTTSProcessor.isAvailable()` executa `edge-tts --version` via `child_process.execFile`. Se o binário não for encontrado ou o comando falhar, retorna `false`. O bootstrap loga: `[Bootstrap] edge-tts not found — voice output disabled.` e prossegue sem TTS. O sistema NÃO aborta se edge-tts estiver ausente — a funcionalidade TTS é puramente opcional.

```typescript
class EdgeTTSProcessor {
  constructor(config: { voice: string; tempDir: string });

  async synthesize(text: string): Promise<string>;  // retorna path do arquivo OGG gerado
  async isAvailable(): Promise<boolean>;
}
```

**Error handling:** Se o binario `edge-tts` nao for encontrado, `isAvailable()` retorna `false`. O OutputHandler faz fallback para `TextOutputStrategy`. Se `synthesize()` falhar, o OutputHandler captura e faz fallback para texto com aviso.

**Temp file management:** O EdgeTTSProcessor gera arquivo OGG em `tempDir`. O nome do arquivo segue a convencao `tts-{uuid}.ogg` (ex: `tts-a1b2c3d4-5678.ogg`), garantindo unicidade entre requisicoes concorrentes e evitando colisoes de nome de arquivo. Se um arquivo com o mesmo nome ja existir (improviavel com UUID), o `EdgeTTSProcessor` sobrescreve. `tempDir` e configurado via variavel de ambiente `TMP_DIR` (padrao `./tmp`). O chamador (AudioOutputStrategy) e responsavel por deletar o arquivo temporario apos envio.

### 8.4 Classes de Estrategia

**TextOutputStrategy:** Divide respostas longas (>4096 chars) em chunks sequenciais. Envia cada chunk via `ctx.reply()` com `await` em loop `for...of` para garantir ordem cronologica.

**FileOutputStrategy:** Escreve conteudo em arquivo `.md` temporario em `./tmp/`, envia via `ctx.replyWithDocument()`, e deleta o arquivo apos envio. Usado quando `result.outputType === "file"`.

**AudioOutputStrategy:** Sintetiza texto em audio OGG via EdgeTTSProcessor (subprocesso `edge-tts`), envia via `ctx.replyWithVoice()`, e deleta o arquivo temporario. Usado quando `result.requiresAudioReply === true`.

**ErrorOutputStrategy:** Formata erros com prefixo de emoji (`\u26a0\ufe0f`) e envia via `ctx.reply()`. Nunca expoe dados internos (paths, API keys, stack traces) na mensagem ao usuario.

Componente lida com a visibilidade final no Chat Window do Telegram Mobile e Web.

---

## 9. Modelo de Dados

Não gera tabela SQLite. É pass-through state. Memória do SQLite captura a string pura unificada antes do Output SplitHandler agir.

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| API Grammy (Send) | Obrigatória | Nenhuma response vai chegar. Timeout nativo por Retry do app telegram após 60 segs (loop eterno para o server node). |
| `edge-tts` (Python package, pip install) | Secundária | O sistema faz fallback para `TextOutputStrategy` com um aviso de erro na geração do áudio. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Rate Limiting Telegram (429 Too Many Requests) | O Output gerou 30 chunks sequenciais por um arquivo colossal e o TG bloqueia Flood. Com CHUNK_SIZE=4000, respostas acima de ~120.000 caracteres produzem 30+ chunks, zona de risco para rate limiting. | Grammy lança `ApiError` com código 429. O OutputHandler captura, extrai o valor do header `Retry-After` (ou usa fallback de 5s), dorme via `sleep(ms)`, e retenta o chunk atual. Grammy não implementa retry automático para 429 — a lógica de espera e retry é responsabilidade do OutputHandler. Se 3 retries consecutivos falharem, os chunks restantes são descartados e o usuário recebe: "⚠️ Mensagem parcial: limite de envios excedido. Tente reduzir o tamanho da resposta." |
| EC-02: Path File Corrupted / Cannot Write TMP | Arquivo `.md` pedido para export mas pasta /tmp sem prems de IO Read. | Captura o err fs.Write, e retrocede mandando como texto em Chunk Alerting pro usário: "Nao consegui gerar arq, segue texto puro...". |
| EC-03: Bot Blocker | O user bloqueia o bot ou desativa mid-reply. | O `ctx.reply` lança erro "Forbidden". Output handler descarta em Catch e loga "Msg abandonada, User bot-blocked" para não falhar stack Node. |

---

## 12. Segurança e Privacidade

- Não é mandado NADA sensivel de internal stacks logs de `Error` que exponham as tokens das APIS Gemini pra tela de erro final. Somente "API Provider Gemini falhou".

---

## 13. Plano de Rollout

Será construído instanciando o `OutputHandler` diretamente na ponta passiva do Controller Root.

---

## 14. Open Questions

- Q1 (Resolvida): MarkdownV1 rejeitado para MVP. Embora V1 seja menos restritivo que V2, ainda exige escape de underscores e asteriscos em certos contextos, e LLMs não são confiáveis para produzir markup consistentemente escapado. Texto puro é a opção mais segura e previsível para o MVP. Suporte a HTML/MarkdownV1 como opt-in (flag de configuração) pode ser considerado na versão 2.
- Q2 (Resolvida): Grammy NÃO implementa retry automático para 429. A biblioteca lança `ApiError` com o código HTTP e o cliente deve implementar a lógica de retry. O comportamento descrito em EC-01 está correto e é responsabilidade do OutputHandler.
- Q3 (Resolvida): Quando o OutputHandler recebe erro 403 "Forbidden: bot was blocked by the user", ele emite um evento `userBlocked` que o AgentController escuta. O Controller então chama `MemoryManager.markConversationBlocked(conversationId)` que seta um flag `blocked = 1` na tabela `conversations`. Na próxima mensagem deste usuário, o Controller verifica o flag e descarta o processamento antes de chegar ao AgentLoop, logando: `[AgentController] Skipping message from blocked user <userId>.` O flag pode ser limpo manualmente via SQLite se o usuário desbloquear o bot.
