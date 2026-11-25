# Spec: Telegram Output Handler

---

## 1. Resumo

O modulo de Output atua como a boca do GeneriClaw. Ele capta o Output resultativo estatico final da Pipeline (do Agent Loop ou das Skills puras processadas) e define as estrategias adequadas de exibicao - seja "Chunking" em mensagens grandes de texto, seja disparo de documentos em markdown ou aviso explicito de timeout e erro com formatacoes de emoji.

---

## 2. Contexto e Motivacao

**Problema:**
LLMs (como GPT-4 e Gemini) sao programados para gerar outputs massivos de 10k-30k tokens em documentacoes continuas e codigos densos. O Telegram tem um hard limit restrito de `4096` caracteres por bolha de mensagem. Um envio direto em texto estoura a API (Erro HTTP 400 Payload Too Large). Alem disso, documentos gerados na pipeline em JSON ou Markdowns complexos nao devem ser "espremidos" em caixas de chat estreitas.

**Evidencias:**
Usuarios frequentemente pedem por exemplo 3 mil linhas de TCC, que o LLM gera, mas o Agent morreria no Output sem dividir.

**Por que agora:**
A padronizacao das outputs de Skills requer renderizar os "arquivos" processados na ponta pra uso (salvar e baixar). Sem um output strategy bem definido, a UX morre no console log ou crashea a aplicacao final.

---

## 3. Goals (Objetivos)

- [ ] G-01: Prover interface `TelegramOutputHandler` para separar preocupacoes de Output.
- [ ] G-02: Receber strings > 4096 docs em `TextOutputStrategy` sendo recortadas dinamicamente sem matar a sintaxe ou palavras ao meio, enviando de forma serial multipla.
- [x] G-03: Entregar erros de provider pela `ErrorOutputStrategy` em vez de como resposta normal. A geracao de arquivos pertence a tool `criar_arquivo` (ver `core-tools.md`), nao ao OutputHandler.
- [ ] G-04: Prover `AudioOutputStrategy` para sintetizar texto em voz (TTS) via Microsoft Edge TTS quando a flag de audio for detectada no Pipeline.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Payload de API Error (4096 bytes ext.) | Alto Risco | 0 Crash de Length | MVP |
| Taxa de Conversao Artefatos para Arquivos | N/A | 100% em .md Skills | Continuo |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Nao implementaremos botoes de inline HTML/CSS no Telegram (Keyboard buttons de sim/nao para o AgentLoop - interface apenas command-line/chat pura simplista inicial).
- NG-02: MarkdownV2 nativo super restritivo (Que exige escape de `()`, `-`, `!` etc). O LLM falha ao escapar nativamente. Usaremos texto formatado cru seguro e legivel de fallback.

---

## 5. Usuarios e Personas

**Usuario:** Generic, via aplicativo de Telegram que se beneficia de uma Timeline dividida limpa pra leitura dos relatorios com suporte a baixar em .MD suas specs, PRDs etc.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O TextOutputStrategy devera fatiar strings se e apenas se a string global ultrapassar o limite de caracteres configurado. | Must | Strings de 9000 caracteres criam 3 bolhas limpas sendo enviadas de forma sequencial via loop `for...of` com `await`, garantindo ordem cronologica estrita de chegada ao usuario. O tamanho do chunk e definido pela constante `CHUNK_SIZE` (padrao: 4000 caracteres). O limite do Telegram e 4096 caracteres por mensagem (nao bytes). A margem de 96 caracteres previne estouro com emojis e caracteres multibyte. |
| RF-02 | O OutputHandler nao converte respostas em anexos. Arquivos sao criados pela tool `criar_arquivo` dentro do `WORKSPACE_ROOT` e o modelo informa o caminho no texto. | Must | Pedir um documento cria o arquivo no workspace e a resposta cita o nome do arquivo. |
| RF-03 | O ErrorOutputStrategy formata em bloco emoji amarelo e dispara apenas avisos. | Must | Erros criticos de Prompt/API disparam "\u26a0\ufe0f Erro: X" ao inves de quebra silenciosa no Nodejs. |
| RF-04 | O AudioOutputStrategy deve sintetizar o texto em audio `.ogg` e enviar como mensagem de voz (`replyWithVoice`) caso a flag `requiresAudioReply` esteja ativa no resultado. | Must | Recebimento de audio no Telegram em substituicao ao texto puro. |

### 6.2 Fluxo Principal (Happy Path)

1. Pipeline AI retornou conteudo com flag `requiresAudioReply: true`.
2. Output Handler aciona `AudioOutputStrategy`.
3. Sistema sinaliza `record_voice` no Telegram.
4. Texto e limpo de Markdown e enviado para o CLI `edge-tts` (Python) via child_process.execFile.
5. Buffer de audio resultante e salvo temporariamente no `./tmp/`.
6. Bot envia o arquivo como Voice Note e deleta o arquivo temporario em seguida.

### 6.3 Fluxos Alternativos

Falhas - ver secao de Edge Cases.

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Ordem das Mensagens (Sync) | 100% Cronologico | Chunks mal organizados perdem sentido. Async/Await estrito no "for...of" loop em vez de map() promise async. |

---

## 8. Design e Interface

### 8.1 TelegramOutputHandler (Facade)

O `TelegramOutputHandler` e o facade que o `AgentController` chama. Ele encapsula o `GrammyContext` e delega para a estrategia correta.

```typescript
/** O que de fato saiu para o usuario - nao o que foi pedido. */
type Delivered = "text" | "voice" | "voice+text" | "error" | "none";

class TelegramOutputHandler {
  private strategies: Map<string, OutputStrategy>;
  private ctx: GrammyContext;

  constructor(ctx: GrammyContext, config: OutputHandlerConfig);

  async send(result: AgentLoopResult): Promise<Delivered>;
  async sendError(text: string): Promise<void>;
}
```

**Por que `Delivered` existe.** `requiresAudioReply` registra o **pedido**. Quando o edge-tts falha,
a resposta sai como texto e os dois casos ficam indistinguiveis em qualquer registro posterior - foi
exatamente o que impediu, por tres rodadas de teste manual, confirmar se a voz funcionava. O valor
devolvido e gravado no `metadata` da mensagem pelo `AgentController` e logado como
`[AgentController] delivered: <valor>`.

**`none`** aparece quando o envio e pulado por shutdown em andamento, ou quando ele lanca erro (ver EC-03).

Uma instancia do handler serve **uma** mensagem: ela encapsula o `Context` daquele update.

**`send(result)`:**
1. Seleciona a estrategia baseada em `result.finishReason` e `result.requiresAudioReply`.
2. Se `result.finishReason === "error"` -> `ErrorOutputStrategy`.
3. Se `result.requiresAudioReply === true` e Edge-TTS disponivel -> `AudioOutputStrategy`.
4. Caso contrario -> `TextOutputStrategy`.
5. Delega `strategy.send(this.ctx, result)`. Nao captura erro: uma falha de envio sobe para o chamador.

**`sendError(text)`:** formata com prefixo `\u26a0\ufe0f` e envia via `ctx.reply()`. Recebe uma
mensagem ja escrita para o usuario; nao recebe `Error` nem tenta extrair nada de um. Usado pelo
`AgentController` quando o pipeline falha fora do `AgentLoop`.

### 8.2 OutputStrategy Interface

```typescript
interface OutputStrategy {
  send(ctx: GrammyContext, result: AgentLoopResult): Promise<Delivered>;
}
```

Cada estrategia devolve o que entregou, e nao o que lhe pediram:

| Estrategia | Devolve |
|---|---|
| `TextOutputStrategy` | sempre `"text"` |
| `AudioOutputStrategy` | `"voice"`; `"voice+text"` quando a resposta foi abreviada para narrar; `"text"` quando o TTS esta ausente ou falhou |
| `ErrorOutputStrategy` | sempre `"error"` |

### 8.3 EdgeTTSProcessor (TTS)

Responsavel pela sintese de texto em audio via Microsoft Edge TTS. Consumido pelo `AudioOutputStrategy`.

**Instalacao:** Edge-TTS e um pacote Python (`edge-tts`) instalado via pip. E uma dependencia OPCIONAL de sistema - se nao estiver instalado, TTS e desabilitado e o OutputHandler faz fallback para texto.

```bash
pip install edge-tts
```

**Validacao de disponibilidade:** Na inicializacao, o `EdgeTTSProcessor.isAvailable()` executa `edge-tts --version` via `child_process.execFile`. Se o binario nao for encontrado ou o comando falhar, retorna `false`. O bootstrap loga: `[Bootstrap] edge-tts not found - voice output disabled.` e prossegue sem TTS. O sistema NAO aborta se edge-tts estiver ausente - a funcionalidade TTS e puramente opcional.

```typescript
class EdgeTTSProcessor {
  constructor(config: { voice: string; tempDir: string; binary?: string; ffmpegBinary?: string });

  async synthesize(text: string): Promise<string>;  // retorna path do arquivo OGG gerado
  async isAvailable(): Promise<boolean>;
}
```

`binary` e `ffmpegBinary` sao configuraveis (`EDGE_TTS_BINARY`, `FFMPEG_BINARY`) pelo mesmo motivo
do whisper: no Windows o `pip` instala o `edge-tts` fora do `PATH`.

**Error handling:** Se o binario `edge-tts` nao for encontrado, `isAvailable()` retorna `false`. O OutputHandler faz fallback para `TextOutputStrategy`. Se `synthesize()` falhar, o OutputHandler captura e faz fallback para texto com aviso.

**Temp file management:** O EdgeTTSProcessor gera arquivo OGG em `tempDir`. O nome do arquivo segue a convencao `tts-{uuid}.ogg` (ex: `tts-a1b2c3d4-5678.ogg`), garantindo unicidade entre requisicoes concorrentes e evitando colisoes de nome de arquivo. Se um arquivo com o mesmo nome ja existir (improviavel com UUID), o `EdgeTTSProcessor` sobrescreve. `tempDir` e configurado via variavel de ambiente `TMP_DIR` (padrao `./tmp`). O chamador (AudioOutputStrategy) e responsavel por deletar o arquivo temporario apos envio.

### 8.4 Classes de Estrategia

**TextOutputStrategy:** Divide respostas longas (>4096 chars) em chunks sequenciais. Envia cada chunk via `ctx.reply()` com `await` em loop `for...of` para garantir ordem cronologica.

### Envio de audio: formato e InputFile

Dois detalhes do caminho de voz que nao sao opcionais, ambos descobertos em producao depois de o
recurso parecer pronto:

**1. edge-tts produz MP3, nao Ogg.** O `--write-media` respeita o nome do arquivo que voce passa,
mas o conteudo e sempre MP3. O `sendVoice` do Telegram so aceita OGG/Opus, entao um MP3 chamado
`.ogg` e recusado. O `EdgeTTSProcessor` grava o MP3 num temporario e converte com ffmpeg
(`-c:a libopus -b:a 32k -ar 48000 -ac 1`) antes de retornar o caminho; o MP3 e removido num
`finally`.

**2. Arquivos locais exigem `InputFile`.** Passar uma string para `ctx.replyWithVoice()` faz o
grammy trata-la como `file_id` ou URL - nunca como caminho em disco. Num caminho Windows o `C:`
vira esquema de URL e o Telegram responde
`400: invalid file HTTP URL specified: Wrong port number specified in the URL`. O correto e
`ctx.replyWithVoice(new InputFile(caminho))`. Vale para qualquer envio de arquivo local.

**3. Sintese tem custo nao-linear; o texto falado precisa de teto.** Medicoes com edge-tts:
~500 caracteres levam 9s, ~3000 levam 78s, ~7000 nao retornaram em 4 minutos. Um resumo completo de
documento e longo demais para narrar, e um audio de varios minutos tambem e ruim de ouvir. O
`AudioOutputStrategy` limita a parte falada a 2000 caracteres, avisa no proprio audio que a resposta
foi abreviada, e envia o texto completo em seguida - nada se perde. O texto vai para o edge-tts por
`--file`, nao `--text`, para manter conteudo longo e caracteres especiais fora da linha de comando.

**4. Toda queda para texto passa pelo chunker.** O `ctx.reply()` recusa mensagens acima de 4096
caracteres. Quando o TTS falhava numa resposta longa, o fallback chamava `ctx.reply()` direto e
falhava de novo com `400: message is too long` - duas falhas em vez de uma, e nenhuma resposta
entregue. Os dois caminhos de fallback do `AudioOutputStrategy` agora delegam ao
`TextOutputStrategy`, que divide em blocos.

**5. A degradacao para texto precisa logar.** O `AudioOutputStrategy` cai para texto quando o TTS
falha, o que e o comportamento certo - o usuario recebe a resposta de qualquer forma. Mas o `catch`
original era vazio, e por isso os dois defeitos acima conviveram com um pipeline de voz que nunca
funcionou: toda falha parecia uma resposta de texto normal. O catch agora loga o motivo.

**Estrategias ativas:** `TextOutputStrategy` (padrao, com chunking em 4000 caracteres), `AudioOutputStrategy` (quando `requiresAudioReply`, com degradacao para texto se o edge-tts estiver ausente) e `ErrorOutputStrategy` (quando `finishReason === "error"`).

Nao existe mais uma `FileOutputStrategy`. Uma heuristica de regex marcava respostas contendo blocos markdown com nome de arquivo e reenviava a resposta inteira como documento. Com a tool `criar_arquivo` funcionando, o mesmo pedido passava a produzir duas entregas: o arquivo correto no workspace e um segundo documento montado a partir do texto da resposta. A heuristica foi removida; a criacao de arquivos pertence a tool.

**AudioOutputStrategy:** Sintetiza texto em audio OGG via EdgeTTSProcessor (subprocesso `edge-tts`), envia via `ctx.replyWithVoice()`, e deleta o arquivo temporario. Usado quando `result.requiresAudioReply === true`.

**ErrorOutputStrategy:** envia o prefixo `\u26a0\ufe0f` seguido da mensagem, nesta ordem de preferencia:

1. `result.finalResponse` - o texto **escrito para o usuario** (ex.: "Desculpe, todos os provedores de IA estao indisponiveis no momento.").
2. `result.errorMessage` - detalhe cru da API, apenas como ultimo recurso, porque o Telegram recusa texto vazio com `400`.

A ordem importa e ja esteve invertida. A estrategia lia `errorMessage` primeiro e **ignorava
`finalResponse` por completo**: o usuario recebia
`\u26a0\ufe0f Erro: xingchen-agi/xing4.0-29b-a4b:free API error: 429 Too Many Requests - {"error":...}`,
com nome de modelo e JSON cru, enquanto a frase cuidadosamente escrita era codigo morto. O detalhe
tecnico continua indo para o log, que e onde ele serve.

Componente lida com a visibilidade final no Chat Window do Telegram Mobile e Web.

---

## 9. Modelo de Dados

Nao gera tabela SQLite. E pass-through state. Memoria do SQLite captura a string pura unificada antes do Output SplitHandler agir.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| API Grammy (Send) | Obrigatoria | Nenhuma response vai chegar. Timeout nativo por Retry do app telegram apos 60 segs (loop eterno para o server node). |
| `edge-tts` (Python package, pip install) | Secundaria | O sistema faz fallback para `TextOutputStrategy` com um aviso de erro na geracao do audio. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Rate Limiting Telegram (429 Too Many Requests) | O Output gerou 30 chunks sequenciais por um arquivo colossal e o TG bloqueia Flood. Com CHUNK_SIZE=4000, respostas acima de ~120.000 caracteres produzem 30+ chunks, zona de risco para rate limiting. | Grammy lanca `ApiError` com codigo 429. O OutputHandler captura, extrai o valor do header `Retry-After` (ou usa fallback de 5s), dorme via `sleep(ms)`, e retenta o chunk atual. Grammy nao implementa retry automatico para 429 - a logica de espera e retry e responsabilidade do OutputHandler. Se 3 retries consecutivos falharem, os chunks restantes sao descartados e o usuario recebe: "\u26a0\ufe0f Mensagem parcial: limite de envios excedido. Tente reduzir o tamanho da resposta." |
| EC-02: Path File Corrupted / Cannot Write TMP | Arquivo `.md` pedido para export mas pasta /tmp sem prems de IO Read. | Captura o err fs.Write, e retrocede mandando como texto em Chunk Alerting pro usario: "Nao consegui gerar arq, segue texto puro...". |
| EC-03: Bot Blocker | O user bloqueia o bot ou desativa mid-reply. | O `ctx.reply` lanca erro 403 "Forbidden". O erro sobe do `send()` ate o `AgentController`, que o loga como erro de pipeline; o aviso ao usuario tambem falha e e ignorado. Nada marca a conversa como bloqueada: quando o usuario desbloqueia o bot, a proxima mensagem e atendida normalmente. |

---

## 12. Seguranca e Privacidade

- Nao e mandado NADA sensivel de internal stacks logs de `Error` que exponham as tokens das APIS Gemini pra tela de erro final. Somente "API Provider Gemini falhou".

---

## 13. Plano de Rollout

Sera construido instanciando o `OutputHandler` diretamente na ponta passiva do Controller Root.

---

## 14. Open Questions

- Q1 (Resolvida): MarkdownV1 rejeitado para MVP. Embora V1 seja menos restritivo que V2, ainda exige escape de underscores e asteriscos em certos contextos, e LLMs nao sao confiaveis para produzir markup consistentemente escapado. Texto puro e a opcao mais segura e previsivel para o MVP. Suporte a HTML/MarkdownV1 como opt-in (flag de configuracao) pode ser considerado na versao 2.
- Q2 (Resolvida): Grammy NAO implementa retry automatico para 429. A biblioteca lanca `ApiError` com o codigo HTTP e o cliente deve implementar a logica de retry. O comportamento descrito em EC-01 esta correto e e responsabilidade do OutputHandler.
- Q3 (Resolvida, revertida): o OutputHandler chegou a emitir um evento `userBlocked` ao receber 403 "Forbidden: bot was blocked by the user", e o Controller marcava `blocked = 1` na conversa e descartava as mensagens seguintes. Nada limpava o flag, entao um bloqueio seguido de desbloqueio trancava o dono para fora, em silencio. O recurso foi removido: o 403 e uma falha de envio comum (ver EC-03). A coluna `blocked` continua em `conversations`, sem uso, para nao criar dois formatos de schema.
