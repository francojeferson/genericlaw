# Spec: Telegram Input Handler

---

## 1. Resumo

O modulo Telegram Input recebe eventos brutos advindos das APIs do Telegram via biblioteca grammy (Long Polling), faz a filtragem de seguranca por whitelist de ID, converte anexos (documentos PDF e arquivos/mensagens de voz de audio) em texto viavel, e injeta na memoria do ciclo de agente para resolucao AI.

---

## 2. Contexto e Motivacao

**Problema:**
Um LLM nativo e as APIs de LLMs cruas (DeepSeek e Gemini) consomem texto e midias num array fixo de History. Eles nao sabem por ondem vem, nem descompactam pacotes PDF ou audios em texto nativamente no formato esperado do chat.
Frequentemente e muito mais pratico para o usuario enviar um audio (Voice Note) no Telegram explicando o que ele deseja, ao inves de digitar textos longos no teclado do celular.

**Evidencias:**
Usuarios frequentemente alimentam "Agentes" com PDFs via chat para analises (Academic Skills). Alem disso, usuarios moveis preferem interagir via audio (Voice) pela comodidade.

**Por que agora:**
A lib Grammy suporta streaming de arquivos anexos por `getFile()`. O Nodejs lida com a ponte em RAM para extracao usando o `pdf-parse`, e a integracao com um modelo Whisper local permite extrair o texto de qualquer audio enviado no chat de forma privada e sem custos de API externa.

---

## 3. Goals (Objetivos)

- [x] G-01: Receber mensagens puras de texto (`message:text`) dos usuarios em whitelist e encaminhar de forma crua ao Pipeline AI (`skill -> agent -> output`).
- [x] G-02: Receber envios de anexo (`message:document`) que sejam do tipo `.pdf` ou `.md`, extrair o texto (via pdf-parse ou leitura UTF-8) e **armazenar o resultado no workspace**, entregando ao modelo um ponteiro em vez do documento inteiro.
- [x] G-03: Expor o comando `/novo` (alias `/reset`) para limpar o historico da conversa.
- [x] G-03b: Expor o comando `/parar` (alias `/stop`) para encerrar o processo a pedido do usuario em whitelist.
- [x] G-04: Receber mensagens de voz (`message:voice`) e arquivos de audio (`message:audio`) de qualquer formato suportado, baixar temporariamente e realizar a transcricao para texto utilizando processamento STT (Speech-to-Text) com Whisper local. O texto transcrito e encaminhado ao Pipeline AI como se fosse texto digitado.
- [x] G-05: Informar instantaneamente ao usuario "Typing..." ou "Recording voice..." via API Telegram pra que o usuario saiba que a string de download/analise pesada esta de fato sob carga de processamento e nao engasgou.
- [x] G-06: Injetar metadados no Agent Loop quando o input do usuario for originado de um audio (Voice Note), sugerindo ao LLM ou ao Output Handler que responda em voz (TTS via `pt-BR-ThalitaMultilingualNeural`) na saida, a depender das regras globais do bot.

**Metricas de sucesso:**
| Metrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Arquivo Fantasma Residual TMP | Infinito | 0 bytes deixados (PDF, MD e Audio) | Always |
| Rate de Parseamento Texto | Text Only | 90% PDFs e 100% MDs lidos | MVP |
| Rate de Transcricao STT | 0% | Modelos locais lidando com audios curtos/medios sem CRASH de RAM | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Midias Visuais cruas / ImageVision. Este escopo e de Texto, Documentos e Audios. Nao aceitaremos JPGs, PNGs ou OCR de imagens estaticas no Input primario nesta especificacao (foco em NLP e processamento textual).
- NG-02: Receber envios via Webhook em Servidor Externo. Rodaremos num loop simples interno Long Polling na maquina local.
- NG-03: Interpretacao semantica de intencao de audio. O sistema usa heuristica simples (input de voz = audio reply, keyword "responda em audio" = audio reply). Textos ambiguos como "sem ser em audio" nao sao interpretados. Esta e uma limitacao permanente documentada em EC-07.
- NG-04: Processamento em tempo real do stream de audio. O sistema precisara que o arquivo inteiro seja baixado para iniciar o Whisper.
- NG-05: Gerar o audio final (TTS) no proprio Input Handler. O modulo de Input e responsavel apenas por **ouvir e sinalizar** que uma resposta em audio foi solicitada explicita ou implicitamente (se o input for audio). Quem envia o arquivo `.ogg` falado e o Output Handler, a partir da flag setada por este modulo ou pelo Agent Loop.

---

## 5. Usuarios e Personas

**Usuario:** Generic interagindo do smartphone para a maquina desktop local atraves de uma DM do Bot do Telegram, mandando comandos de voz dirigindo o carro pedindo para o agente agir e exigindo receber a resposta de volta em formato de voz (TTS Thalita) para audicao rapida sem contato visual no app.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Criterio de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O sistema deve ouvir eventos `message:text` filtrados. | Must | Bot intercepta Msg ID 123 valida em < 2 segundos e o sistema inicia memory. |
| RF-02 | O sistema deve acionar a extracao local quando receber Documentos com mimetype `application/pdf` ou arquivos contendo a extensao `.md`. | Must | O sistema retorna o conteudo do arquivo transformado em bloco de texto concatenado a Legenda. |
| RF-03 | O sistema deve excluir os documentos baixados da `tmpDir` (`./tmp`) apos o parse ou em caso de erro. | Must | Exclusao do rastro na clausula finally da try-catch. Sem memory leaks no FileSystem. |
| RF-04 | O sistema deve ouvir eventos de voz (`message:voice`) e audio (`message:audio`). | Must | O sistema reconhece anexo de audio e o envia para parser do Whisper. |
| RF-05 | O sistema deve usar o Whisper Local para transcrever o audio baixado para texto. Whisper e invocado via child process (`child_process.execFile`) com o binario CLI, nao como biblioteca no processo Node. Isso isola crashes e evita inflar a memoria do processo principal com modelos multi-GB. | Must | Audio convertido para STT. O log do bot mostra "Transcript: xyz" e o sistema envia para o Agent Loop. |
| RF-06 | O sistema deve sinalizar a preferencia por audio (TTS) caso o input seja originario de voz ou o texto possua keyword explicita ("responda em audio" / "fale comigo"). A deteccao de keywords e case-insensitive (ex: "Responda em Audio" tambem ativa TTS) e busca a keyword como substring em qualquer posicao do texto. A lista de keywords e exaustiva e documentada - variacoes, sinonimos ou typos nao sao reconhecidos (ver EC-07). | Must | O payload injetado na Memory contera um marcador booleano `requires_audio_reply: true` e a *voice_id* fixada em `pt-BR-ThalitaMultilingualNeural`. |
| RF-07 | O sistema deve converter audio do formato OGG/OPUS do Telegram para WAV mono 16kHz usando ffmpeg antes de passar ao Whisper. ffmpeg e dependencia OBRIGATORIA de sistema. Se ausente na inicializacao, entrada de voz e desabilitada e o usuario recebe: "Voz desabilitada: ffmpeg nao encontrado no sistema." | Must | Arquivo OGG do Telegram e convertido para WAV e o Whisper transcreve corretamente. |

### 6.2 Fluxo Principal (Happy Path)

1. Entrada: "Cria um PRD pro meu novo app de financas e me responde em audio" enviado por Voice Note no Telegram Client pelo usuario.
2. O gate de acesso do Grammy (`bot.use`) valida que o chat e privado e que o user ID esta em `TELEGRAM_ALLOWED_USER_IDS`.
3. Evento classificado como Voz via `on(["message:voice", "message:audio"])`.
4. Bot Controller atualiza status para o usuario do Telegram: `sendChatAction('record_voice')` ou `typing`. Best-effort: se a chamada falhar, o fluxo segue.
5. API de stream do TG contata URL temporaria interna para baixar chunks raw do audio (`.ogg`, `.mp3`) no `/tmp/`.
6. Arquivo salvo e encaminhado para o modulo de audio usando o modelo Whisper local (subprocesso/lib).
7. O sistema devolve o texto transcrito em PT-BR (ou detectado automaticamente pelo Whisper) com uma metatag interna marcando o trigger de TTS de volta, e o sistema exclui o physical temp file na conclusao do hook.
8. Texto transcrito e a Flag `requires_audio_reply` seguem para o Agent Loop injetados pelo sistema, habilitando o Telegram Output a renderizar a engine `edge_tts` no fim da chain.

### 6.3 Fluxos Alternativos

Falhas - ver secao 11.

---

## 7. Requisitos Nao-Funcionais

| ID | Requisito | Valor alvo | Observacao |
|----|-----------|-----------|------------|
| RNF-01 | Async IO | 100% Non-Blocking | O arquivo baixando nao interrompe msgs concorrentes de texto enviadas. |
| RNF-02 | STT Performance | < 2x a duracao | O tempo para Whisper processar STT nao deve exceder significativamente a extracao local dependendo da GPU ou CPU usada. Margem maxima absoluta: 5 minutos. Se o processamento exceder esse teto, timeout e fallback para resposta de erro. |

---

## 8. Design e Interface

### 8.1 WhisperProcessor (STT)

Responsavel pela transcricao de audio para texto via Whisper local.

```typescript
class WhisperProcessor {
  // modelPath e derivado de WHISPER_MODEL: `./models/whisper/ggml-{WHISPER_MODEL}.bin`
  // binaryPath e o valor de WHISPER_BINARY (padrao: "whisper")
  constructor(config: { modelPath: string; binaryPath: string; tempDir: string });

  async transcribe(audioFilePath: string): Promise<string>;
  async isAvailable(): Promise<boolean>;
}
```

**Error handling:** Se o binario `whisper` nao for encontrado ou o modelo nao existir, `isAvailable()` retorna `false`. O InputHandler desabilita entrada de voz e notifica o usuario. Se `transcribe()` falhar, a excecao encapsulada informa se foi timeout (60s), OOM ou modelo corrompido.

**Temp file management:** O WhisperProcessor NAO gerencia arquivos temporarios - o InputHandler passa o path do arquivo ja convertido (WAV) e e responsavel por deleta-lo no `finally`.

### 8.2 TelegramInputHandler (Facade)

Classe principal que conecta os listeners do Grammy e produz `ProcessedInput` para o `AgentController`. Referenciada por architecture.md, bootstrap.md e agent-controller.md.

```typescript
class TelegramInputHandler {
  private bot: GrammyBot;
  private whisper: WhisperProcessor;
  private allowedUserIds: string[];
  private tmpDir: string;
  private controller: AgentController;

  constructor(deps: TelegramInputHandlerDeps);

  // Registra os listeners do Grammy e inicia o polling
  async start(): Promise<void>;

  // Handlers de mensagem
  private async handleText(ctx: GrammyContext): Promise<void>;
  private async handleVoice(ctx: GrammyContext): Promise<void>;
  private async handleAudio(ctx: GrammyContext): Promise<void>;
  private async handleDocument(ctx: GrammyContext): Promise<void>;

  // Processamento de anexos
  private async downloadFile(fileId: string): Promise<string>;   // retorna path do arquivo baixado
  private async extractPdfText(filePath: string): Promise<string>;
  private async extractMarkdownText(filePath: string): Promise<string>;

  // Constroi ProcessedInput a partir do contexto e conteudo extraido
  private buildProcessedInput(
    ctx: GrammyContext,
    content: string,
    source: "text" | "voice" | "document",
    requiresAudioReply: boolean
  ): ProcessedInput;
}
```

**Contrato de `start()`:** Registra, **nesta ordem**, `bot.catch`, o gate de acesso (`bot.use`), os
comandos `/novo` (alias `/reset`) e `/parar` (alias `/stop`) e os listeners para `message:text`,
`message:voice`, `message:audio` e `message:document`. A ordem importa: o grammy encerra a cadeia no
primeiro handler que nao chama `next()`, entao registrar o comando primeiro impede que `/novo` seja
tratado como texto comum e enviado ao LLM, e o gate registrado antes de tudo e o que impede qualquer
handler de rodar para quem nao deve. Cada listener extrai conteudo, monta `ProcessedInput` e chama
`controller.handle(processedInput)`.

**Gate de acesso.** Um unico `bot.use` chama `next()` somente quando `ctx.chat.type === "private"` e
`ctx.from.id` esta em `allowedUserIds`. Qualquer outro update (id fora da lista, grupo, update sem
remetente) e ignorado em silencio: sem resposta e sem log. Os handlers nao repetem a checagem. Antes
eram cinco copias coladas, uma por handler, sem teste, e nenhuma exigia chat privado.

**`bot.catch`.** Sem handler de erro, o grammy relanca a excecao do primeiro handler que falhar e
para o polling; `start()` retorna e o `main.ts` encerra o processo (ver `bootstrap.md` EC-04). O
`bot.catch` loga `[Telegram] handler failed:` com o erro e o polling continua. Pelo mesmo motivo, o
`replyWithChatAction("typing")` dos tres handlers e best-effort (`.catch(() => {})`): um 429 no
"digitando" nao cancela a mensagem do usuario.

**Contrato de `/parar` (alias `/stop`):** dispara a mesma sequencia de encerramento dos sinais
SIGINT/SIGTERM, via o callback `onShutdown` recebido do bootstrap.

O encerramento e **agendado para depois** do handler retornar (`setTimeout`), nao aguardado dentro
dele: `shutdown()` chama `bot.stop()`, que espera os handlers em andamento terminarem. Chamar de
dentro do proprio handler travaria.

Este comando existe porque o bot roda como processo de segundo plano sem terminal interativo. No
Windows nao ha forma confiavel de entregar SIGINT a um processo Node sem console - `taskkill` sem
`/F` recusa, e tanto o PowerShell quanto o MSYS2 caem em `TerminateProcess`, que ignora handlers.
Sem `/parar`, todo encerramento vira kill forcado: a gravacao final do banco nao roda e arquivos
temporarios de TTS vazam em `tmp/`.

**Contrato de `/novo`:** chama `controller.resetConversation(conversationId)` e
responde com a contagem de mensagens apagadas. Apaga **somente** o historico: a linha da conversa
permanece (remove-la quebraria a foreign key da proxima mensagem) e os arquivos ja criados no
workspace nao sao tocados - a resposta diz isso explicitamente, porque "reiniciar" pode ser lido
como apagar os arquivos tambem.

**Contrato de `buildProcessedInput()`:** Gera `conversationId` a partir de `String(ctx.chat.id)` (conversao explicita de number para string - Telegram chat IDs sao numeros), extrai `userId` de `String(ctx.from.id)`, e preenche `requiresAudioReply` com `true` se o input for voz ou contiver keyword "responda em audio" / "fale comigo". A conversao `String()` e obrigatoria e deve ser aplicada em todos os handlers que produzem `ProcessedInput`. Ver RF-06 para regras de deteccao de audio reply.

**Contrato de transcricao:** `WhisperProcessor` invoca o CLI do **whisper.cpp** - nao o `whisper`
do Python, cujos flags sao diferentes e que arrasta o torch junto. Os argumentos sao
`--model <ggml.bin> --file <wav> --language <lang> --output-txt --output-file <base>`.

`--language` nao e opcional na pratica: sem ele o whisper.cpp assume ingles e **traduz** o audio em
vez de transcrever. Um audio em pt-BR pedindo "crie um arquivo..." volta como "Create a file...",
que entao entra num agente cujo system prompt exige respostas em pt-BR. O padrao e `pt`,
configuravel via `WHISPER_LANGUAGE`.

`npm run setup:whisper` baixa o CLI e o modelo ggml. Em builds recentes do whisper.cpp o executavel
`main` existe apenas como stub que imprime um aviso de depreciacao e sai - o binario real e
`whisper-cli`, e e esse que o setup seleciona.

**Contrato de download/extracao:** `downloadFile` obtem a URL via `bot.api.getFile()` e grava em
`tmpDir` como `download-<uuid>.<ext>`. `extractPdfText` usa `pdf-parse`; markdown e lido como UTF-8.
Arquivos temporarios sao deletados no `finally` de cada handler.

**O nome do temporario usa `crypto.randomUUID()`, nao `Date.now()`.** Dois uploads no mesmo
milissegundo geravam o mesmo caminho: o segundo sobrescrevia o arquivo do primeiro **antes de ele
ser lido**, e os dois turnos processavam o mesmo conteudo - um documento sumia em silencio. A
fronteira de `await` entre gravar e ler basta para a corrida acontecer.

**Contrato de armazenamento de upload:** o texto extraido **nao** vira o conteudo da mensagem. Ele e
gravado no `WORKSPACE_ROOT` em `uploads/<nome-seguro>` via `CriarArquivoTool`, e o
`ProcessedInput.content` recebe um ponteiro curto: o nome original, o caminho no workspace, o
tamanho em caracteres, a instrucao de usar `ler_arquivo`, e uma previa de 500 caracteres.

O motivo e custo: o conteudo de uma mensagem e reenviado como contexto a cada turno seguinte dentro
da janela `MEMORY_WINDOW_SIZE`. Um PDF embutido inteiro (limitado a 64KB pelo MemoryManager) seria
reproduzido em ~20 turnos. Medido com um PDF real de 201KB: o primeiro prompt ficou em 1.1k tokens,
contra cerca de 16k se o texto fosse embutido.

`uploadPathFor(fileName, isPdf, existe?)` deriva o destino: aplica `path.basename` (um `file_name`
do Telegram e dado do usuario e pode conter `../`), substitui caracteres inseguros, troca a extensao
`.pdf` por `.md`, e cai para `documento` se nada utilizavel sobrar. Se a gravacao falhar, o handler
degrada embutindo o texto como antes, em vez de perder o documento.

**Nomes repetidos nao se sobrescrevem.** O terceiro parametro e um predicado de existencia; quando
`uploads/contrato.md` ja existe, o destino vira `uploads/contrato-2.md`, depois `-3`, e assim por
diante. O handler o alimenta com `resolveInWorkspace() + fs.existsSync()`.

O comportamento anterior era `overwrite: true` fixo, com a justificativa de que reenviar o mesmo
arquivo deveria substituir o anterior. O problema e que o nome vem do usuario e colide entre
documentos diferentes: dois `contrato.pdf` de clientes distintos deixavam apenas o segundo em disco,
e as conversas anteriores, que ja tinham dito ao modelo "o conteudo esta em `uploads/contrato.md`",
passavam a apontar para o documento errado.

`shortcut:` o sufixo para em 999; acima disso o arquivo e sobrescrito. Para um agente pessoal esse
teto nunca e alcancado.

Pura estrutura Middleware no App Controller sem vizualizacao fora o Client TG nativo do smartphone do usuario. Apenas havera feedback de actions como envio de texto simulando se o bot realmente ouviu em paralelo a extracao STT.

---

## 9. Modelo de Dados

Nao gera tabela SQLite (Input apenas intermedeia).
As mensagens se tornam blocos injetados na Memory SQLite com as quebras. 
A pasta `/tmp/` retem temporariamente `.pdf`, `.md`, `.mp3`, `.ogg`, etc.

---

## 10. Integracoes e Dependencias

| Dependencia | Tipo | Impacto se indisponivel |
|-------------|------|------------------------|
| GrammyJS | Obrigatoria | Nenhuma intercepcao ocorrera. |
| Pdf-Parse npm | Secundaria | Texto caira no Agent Loop como string vazia de documento ininteligivel. |
| Whisper Local CLI/Lib | Secundaria | Falha a transcricao e bot responde: "\u26a0\ufe0f Nao consegui inicializar o Whisper local agora." |
| Engine Edge-TTS | Secundaria | O Input mapeia a Flag de audio. Se o modulo Output falhar em processar, ocorre Fall-back para texto no final. O impacto primario de identificar a intencao e salvo. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenario | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Anexo nao e suportado | Usuario envia DOCX, XLS ou JPG. | O sistema responde via Telegram: "\u26a0\ufe0f No momento, so consigo processar texto estruturado (.md), audio e PDF.", cancela o processamento e aciona a limpeza do TEMP. |
| EC-02: OOM (Out of Memory) no Whisper | Audio massivo pesa e Whisper crasha o processo no host. | Timeout de 60s e trycatch do Node envelopa falha. O sistema envia e o usuario recebe: "\u26a0\ufe0f Falha ao processar o audio: arquivo grande demais ou falha no servico." |
| EC-03: Audio vazio ou mudo | Arquivo com barulho nulo enviado. | Whisper retorna `""`. O sistema envia a resposta ao usuario: "Audio vazio captado. Pode reenviar?" e nao polui o Agent Loop com string vazia. |
| EC-04: PDF massivo | Upload finalizado e parsing travando estourando local. | Envelopamento de limite de Bytes (ex. 20MB max para text extract). O Catch block captura falha de Memory e o sistema limpa o TEMP no `finally`. O usuario recebe alerta de PDF muito grande. |
| EC-05: Timeout da API do Telegram (Download de Midia) | A rede falha durante o streaming do arquivo de audio ou PDF pelo Telegram. | O downloader da throw de Timeout apos 15 segundos sem bytes recebidos. O bot envia mensagem ao usuario: "\u26a0\ufe0f Falha ao baixar arquivo do Telegram. Tente novamente." e a promise falha limpando qualquer resquicio de chunk. |
| EC-06: API de LLM Externa indisponivel para Agent Loop | STT extrai o texto perfeitamente, a LLM do Core cai em seguida | O STT conclui sua parte transcrevendo e injeta o texto na Memory. A falha da LLM subsequente e tratada pelo Handler Generativo. O input e mantido como texto salvo. |
| EC-07: Solicitacao explicita por audio ambigua | Usuario manda "responda isso sem ser em audio" | Limitacao conhecida: o sistema usa heuristica simples (input de voz = requer audio reply, keyword "responda em audio" = requer audio reply). Textos ambiguos como "sem ser em audio" nao sao interpretados. Mitigacao: o usuario sempre pode desligar o TTS manualmente no Output ou o OutputHandler oferece fallback para texto. Documentado como limitacao permanente - mover para Non-Goals na versao 2. |
| EC-08: PDF criptografado ou protegido por senha | Usuario envia PDF com protecao de senha ou criptografia DRM. | `pdf-parse` falha na extracao. O sistema captura o erro, responde: "\u26a0\ufe0f Nao foi possivel extrair texto deste PDF. Ele pode estar protegido por senha ou criptografado." e limpa o arquivo temporario. |
| EC-09: PDF escaneado ou baseado em imagem | Usuario envia PDF gerado por scanner (paginas sao imagens, nao texto selecionavel). | `pdf-parse` retorna string vazia ou com muito pouco texto. O sistema detecta resultado vazio (< 10 caracteres apos trim) e responde: "\u26a0\ufe0f Este PDF parece conter apenas imagens escaneadas. Nao foi possivel extrair texto." OCR nao e suportado no MVP. |
| EC-10: PDF com encoding corrompido ou misto | PDF contem fontes com encoding invalido, mistura de UTF-8 e Latin-1, ou caracteres nao mapeados. | `pdf-parse` pode lancar excecao ou retornar texto com caracteres de substituicao (Unicode replacement character `\uFFFD`). O sistema captura a excecao e responde com mensagem de erro generica. Caracteres `\uFFFD` sao aceitos como texto valido - a limpeza de encoding nao e responsabilidade do InputHandler. |
| EC-11: PDF corrompido ou arquivo invalido | Usuario renomeou um `.exe` ou `.zip` para `.pdf`, ou o arquivo esta truncado. | `pdf-parse` lanca excecao de parse. O sistema captura e responde: "\u26a0\ufe0f Arquivo PDF invalido ou corrompido." e limpa o arquivo temporario. |

---

## 12. Seguranca e Privacidade

- **Upload e Download Seguro:** Ao nao salvar links externos nem exibir uploads localmente de forma compartilhada, asseguramos sandboxing.
- **Transcricoes Locais:** A voz trafega end-to-end do telegram ao storage local e e consumida localmente sem ir para OpenAI Whisper cloud endpoints. Total controle de privacidade.

---

## 13. Plano de Rollout

Entregue: texto, voz (whisper local), documentos `.md`/`.pdf`, whitelist por id, os comandos
`/novo` e `/parar`, e o armazenamento de upload com ponteiro. Coberto por
`tests/audio-request.test.ts`, `tests/upload-path.test.ts` e `tests/upload-collision.test.ts` - este
ultimo dispara o handler real registrado por `start()`, com `bot` e `fetch` falsos, e verifica os
arquivos no disco, o gate de acesso (cada handler, passando pelo gate) e o `bot.catch`.

Em aberto: nenhum item de rollout. OCR de PDF escaneado segue fora do escopo (NG-01).

---

## 14. Open Questions (Resolvidos)

As perguntas abaixo foram resolvidas e suas decisoes foram promovidas para a secao de requisitos (RF-05 e RF-07):

- **Q1 (Resolvida):** Invocacao do Whisper via Node.js -> Decisao: `child_process.execFile`. Ver RF-05.
- **Q2 (Resolvida):** Conversao de formato de audio -> Decisao: ffmpeg obrigatorio. Ver RF-07.
