# Spec: Telegram Input Handler

---

## 1. Resumo

O módulo Telegram Input recebe eventos brutos advindos das APIs do Telegram via biblioteca grammy (Long Polling), faz a filtragem de segurança por whitelist de ID, converte anexos (documentos PDF e arquivos/mensagens de voz de áudio) em texto viável, e injeta na memória do ciclo de agente para resolução AI.

---

## 2. Contexto e Motivação

**Problema:**
Um LLM nativo e as APIs de LLMs cruas (DeepSeek e Gemini) consomem texto e mídias num array fixo de History. Eles não sabem por ondem vêm, nem descompactam pacotes PDF ou áudios em texto nativamente no formato esperado do chat.
Frequentemente é muito mais prático para o usuário enviar um áudio (Voice Note) no Telegram explicando o que ele deseja, ao invés de digitar textos longos no teclado do celular.

**Evidências:**
Usuários frequentemente alimentam "Agentes" com PDFs via chat para analises (Academic Skills). Além disso, usuários móveis preferem interagir via áudio (Voice) pela comodidade.

**Por que agora:**
A lib Grammy suporta streaming de arquivos anexos por `getFile()`. O Nodejs lida com a ponte em RAM para extração usando o `pdf-parse`, e a integração com um modelo Whisper local permite extrair o texto de qualquer áudio enviado no chat de forma privada e sem custos de API externa.

---

## 3. Goals (Objetivos)

- [ ] G-01: Receber mensagens puras de texto (`message:text`) dos usuários em whitelist e encaminhar de forma crua ao Pipeline AI (`skill -> agent -> output`).
- [ ] G-02: Receber envios de anexo (`message:document`) que sejam do tipo `.pdf` ou `.md`, salvando temporariamente no disco para leitura (via pdf-parse ou leitura de texto puro).
- [ ] G-03: Receber mensagens de voz (`message:voice`) e arquivos de áudio (`message:audio`) de qualquer formato suportado, baixar temporariamente e realizar a transcrição para texto utilizando processamento STT (Speech-to-Text) com Whisper local. O texto transcrito é encaminhado ao Pipeline AI como se fosse texto digitado.
- [ ] G-04: Informar instantaneamente ao usuário "Typing..." ou "Recording voice..." via API Telegram pra que o usuário saiba que a string de download/análise pesada está de fato sob carga de processamento e não engasgou.
- [ ] G-05: Injetar metadados no Agent Loop quando o input do usuário for originado de um áudio (Voice Note), sugerindo ao LLM ou ao Output Handler que responda em voz (TTS via `pt-BR-ThalitaMultilingualNeural`) na saída, a depender das regras globais do bot.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Arquivo Fantasma Residual TMP | Infinito | 0 bytes deixados (PDF, MD e Audio) | Always |
| Rate de Parseamento Texto | Text Only | 90% PDFs e 100% MDs lidos | MVP |
| Rate de Transcrição STT | 0% | Modelos locais lidando com áudios curtos/médios sem CRASH de RAM | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Mídias Visuais cruas / ImageVision. Este escopo é de Texto, Documentos e Áudios. Não aceitaremos JPGs, PNGs ou OCR de imagens estáticas no Input primário nesta especificação (foco em NLP e processamento textual).
- NG-02: Receber envios via Webhook em Servidor Externo. Rodaremos num loop simples interno Long Polling na máquina local.
- NG-03: Interpretação semântica de intenção de áudio. O sistema usa heurística simples (input de voz = audio reply, keyword "responda em audio" = audio reply). Textos ambíguos como "sem ser em audio" não são interpretados. Esta é uma limitação permanente documentada em EC-07.
- NG-04: Processamento em tempo real do stream de áudio. O sistema precisará que o arquivo inteiro seja baixado para iniciar o Whisper.
- NG-05: Gerar o áudio final (TTS) no próprio Input Handler. O módulo de Input é responsável apenas por **ouvir e sinalizar** que uma resposta em áudio foi solicitada explícita ou implicitamente (se o input for áudio). Quem envia o arquivo `.ogg` falado é o Output Handler, a partir da flag setada por este módulo ou pelo Agent Loop.

---

## 5. Usuários e Personas

**Usuario:** Generic interagindo do smartphone para a máquina desktop local através de uma DM do Bot do Telegram, mandando comandos de voz dirigindo o carro pedindo para o agente agir e exigindo receber a resposta de volta em formato de voz (TTS Thalita) para audição rápida sem contato visual no app.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O sistema deve ouvir eventos `message:text` filtrados. | Must | Bot intercepta Msg ID 123 válida em < 2 segundos e o sistema inicia memory. |
| RF-02 | O sistema deve acionar a extração local quando receber Documentos com mimetype `application/pdf` ou arquivos contendo a extensão `.md`. | Must | O sistema retorna o conteúdo do arquivo transformado em bloco de texto concatenado à Legenda. |
| RF-03 | O sistema deve excluir os documentos baixados da `tmpDir` (`./tmp`) após o parse ou em caso de erro. | Must | Exclusão do rastro na clausula finally da try-catch. Sem memory leaks no FileSystem. |
| RF-04 | O sistema deve ouvir eventos de voz (`message:voice`) e áudio (`message:audio`). | Must | O sistema reconhece anexo de aúdio e o envia para parser do Whisper. |
| RF-05 | O sistema deve usar o Whisper Local para transcrever o audio baixado para texto. Whisper e invocado via child process (`child_process.execFile`) com o binario CLI, nao como biblioteca no processo Node. Isso isola crashes e evita inflar a memoria do processo principal com modelos multi-GB. | Must | Audio convertido para STT. O log do bot mostra "Transcript: xyz" e o sistema envia para o Agent Loop. |
| RF-06 | O sistema deve sinalizar a preferencia por audio (TTS) caso o input seja originario de voz ou o texto possua keyword explicita ("responda em audio" / "fale comigo"). A deteccao de keywords e case-insensitive (ex: "Responda em Audio" tambem ativa TTS) e busca a keyword como substring em qualquer posicao do texto. A lista de keywords e exaustiva e documentada — variacoes, sinonimos ou typos nao sao reconhecidos (ver EC-07). | Must | O payload injetado na Memory contera um marcador booleano `requires_audio_reply: true` e a *voice_id* fixada em `pt-BR-ThalitaMultilingualNeural`. |
| RF-07 | O sistema deve converter audio do formato OGG/OPUS do Telegram para WAV mono 16kHz usando ffmpeg antes de passar ao Whisper. ffmpeg e dependencia OBRIGATORIA de sistema. Se ausente na inicializacao, entrada de voz e desabilitada e o usuario recebe: "Voz desabilitada: ffmpeg nao encontrado no sistema." | Must | Arquivo OGG do Telegram e convertido para WAV e o Whisper transcreve corretamente. |

### 6.2 Fluxo Principal (Happy Path)

1. Entrada: "Cria um PRD pro meu novo app de finanças e me responde em áudio" enviado por Voice Note no Telegram Client pelo usuário.
2. Bot Grammy valida se user ID = `TELEGRAM_ALLOWED_USER_IDS`.
3. Evento classificado como Voz via `on(["message:voice", "message:audio"])`.
4. Bot Controller atualiza status para o usuário do Telegram: `sendChatAction('record_voice')` ou `typing`.
5. API de stream do TG contata URL temporária interna para baixar chunks raw do áudio (`.ogg`, `.mp3`) no `/tmp/`.
6. Arquivo salvo é encaminhado para o módulo de áudio usando o modelo Whisper local (subprocesso/lib).
7. O sistema devolve o texto transcrito em PT-BR (ou detectado automaticamente pelo Whisper) com uma metatag interna marcando o trigger de TTS de volta, e o sistema exclui o physical temp file na conclusão do hook.
8. Texto transcrito e a Flag `requires_audio_reply` seguem para o Agent Loop injetados pelo sistema, habilitando o Telegram Output a renderizar a engine `edge_tts` no fim da chain.

### 6.3 Fluxos Alternativos

Falhas - ver seção 11.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Async IO | 100% Non-Blocking | O arquivo baixando nao interrompe msgs concorrentes de texto enviadas. |
| RNF-02 | STT Performance | < 2x a duração | O tempo para Whisper processar STT não deve exceder significativamente a extração local dependendo da GPU ou CPU usada. Margem máxima absoluta: 5 minutos. Se o processamento exceder esse teto, timeout e fallback para resposta de erro. |

---

## 8. Design e Interface

### 8.1 WhisperProcessor (STT)

Responsavel pela transcricao de audio para texto via Whisper local.

```typescript
class WhisperProcessor {
  // modelPath é derivado de WHISPER_MODEL: `./models/whisper/ggml-{WHISPER_MODEL}.bin`
  // binaryPath é o valor de WHISPER_BINARY (padrão: "whisper")
  constructor(config: { modelPath: string; binaryPath: string; tempDir: string });

  async transcribe(audioFilePath: string): Promise<string>;
  async isAvailable(): Promise<boolean>;
}
```

**Error handling:** Se o binario `whisper` nao for encontrado ou o modelo nao existir, `isAvailable()` retorna `false`. O InputHandler desabilita entrada de voz e notifica o usuario. Se `transcribe()` falhar, a excecao encapsulada informa se foi timeout (60s), OOM ou modelo corrompido.

**Temp file management:** O WhisperProcessor NAO gerencia arquivos temporarios — o InputHandler passa o path do arquivo ja convertido (WAV) e e responsavel por deleta-lo no `finally`.

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

**Contrato de `start()`:** Registra listeners para `message:text`, `message:voice`, `message:audio` e `message:document`. Cada listener valida `ctx.from.id` contra `allowedUserIds`, extrai conteudo, monta `ProcessedInput` e chama `controller.handle(processedInput)`.

**Contrato de `buildProcessedInput()`:** Gera `conversationId` a partir de `String(ctx.chat.id)` (conversao explicita de number para string — Telegram chat IDs sao numeros), extrai `userId` de `String(ctx.from.id)`, e preenche `requiresAudioReply` com `true` se o input for voz ou contiver keyword "responda em audio" / "fale comigo". A conversao `String()` e obrigatoria e deve ser aplicada em todos os handlers que produzem `ProcessedInput`. Ver RF-06 para regras de deteccao de audio reply.

**Contrato de download/extração:** `downloadFile` obtem URL de download via `bot.api.getFile()` e faz stream para `tmpDir`. `extractPdfText` usa `pdf-parse`. `extractMarkdownText` le o arquivo como UTF-8. Ambos retornam string vazia em caso de falha. Arquivos temporarios sao deletados no `finally` de cada handler.

Pura estrutura Middleware no App Controller sem vizualizacao fora o Client TG nativo do smartphone do usuario. Apenas havera feedback de actions como envio de texto simulando se o bot realmente ouviu em paralelo a extracao STT.

---

## 9. Modelo de Dados

Não gera tabela SQLite (Input apenas intermedeia).
As mensagens se tornam blocos injetados na Memory SQLite com as quebras. 
A pasta `/tmp/` retém temporariamente `.pdf`, `.md`, `.mp3`, `.ogg`, etc.

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| GrammyJS | Obrigatória | Nenhuma intercepção ocorrerá. |
| Pdf-Parse npm | Secundária | Texto cairá no Agent Loop como string vazia de documento ininteligível. |
| Whisper Local CLI/Lib | Secundária | Falha a transcrição e bot responde: "⚠️ Não consegui inicializar o Whisper local agora." |
| Engine Edge-TTS | Secundária | O Input mapeia a Flag de áudio. Se o módulo Output falhar em processar, ocorre Fall-back para texto no final. O impacto primário de identificar a intenção é salvo. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Anexo não é suportado | Usuário envia DOCX, XLS ou JPG. | O sistema responde via Telegram: "⚠️ No momento, só consigo processar texto estruturado (.md), áudio e PDF.", cancela o processamento e aciona a limpeza do TEMP. |
| EC-02: OOM (Out of Memory) no Whisper | Áudio massivo pesa e Whisper crasha o processo no host. | Timeout de 60s e trycatch do Node envelopa falha. O sistema envia e o usuário recebe: "⚠️ Falha ao processar o áudio: arquivo grande demais ou falha no serviço." |
| EC-03: Áudio vazio ou mudo | Arquivo com barulho nulo enviado. | Whisper retorna `""`. O sistema envia a resposta ao usuário: "Áudio vazio captado. Pode reenviar?" e não polui o Agent Loop com string vazia. |
| EC-04: PDF massivo | Upload finalizado e parsing travando estourando local. | Envelopamento de limite de Bytes (ex. 20MB max para text extract). O Catch block captura falha de Memory e o sistema limpa o TEMP no `finally`. O usuário recebe alerta de PDF muito grande. |
| EC-05: Timeout da API do Telegram (Download de Mídia) | A rede falha durante o streaming do arquivo de áudio ou PDF pelo Telegram. | O downloader dá throw de Timeout após 15 segundos sem bytes recebidos. O bot envia mensagem ao usuário: "⚠️ Falha ao baixar arquivo do Telegram. Tente novamente." e a promise falha limpando qualquer resquício de chunk. |
| EC-06: API de LLM Externa indisponível para Agent Loop | STT extrai o texto perfeitamente, a LLM do Core cai em seguida | O STT conclui sua parte transcrevendo e injeta o texto na Memory. A falha da LLM subsequente é tratada pelo Handler Generativo. O input é mantido como texto salvo. |
| EC-07: Solicitacao explicita por audio ambigua | Usuario manda "responda isso sem ser em audio" | Limitacao conhecida: o sistema usa heuristica simples (input de voz = requer audio reply, keyword "responda em audio" = requer audio reply). Textos ambiguos como "sem ser em audio" nao sao interpretados. Mitigacao: o usuario sempre pode desligar o TTS manualmente no Output ou o OutputHandler oferece fallback para texto. Documentado como limitacao permanente — mover para Non-Goals na versao 2. |
| EC-08: PDF criptografado ou protegido por senha | Usuario envia PDF com protecao de senha ou criptografia DRM. | `pdf-parse` falha na extracao. O sistema captura o erro, responde: "⚠️ Nao foi possivel extrair texto deste PDF. Ele pode estar protegido por senha ou criptografado." e limpa o arquivo temporario. |
| EC-09: PDF escaneado ou baseado em imagem | Usuario envia PDF gerado por scanner (paginas sao imagens, nao texto selecionavel). | `pdf-parse` retorna string vazia ou com muito pouco texto. O sistema detecta resultado vazio (< 10 caracteres apos trim) e responde: "⚠️ Este PDF parece conter apenas imagens escaneadas. Nao foi possivel extrair texto." OCR nao e suportado no MVP. |
| EC-10: PDF com encoding corrompido ou misto | PDF contem fontes com encoding invalido, mistura de UTF-8 e Latin-1, ou caracteres nao mapeados. | `pdf-parse` pode lancar excecao ou retornar texto com caracteres de substituicao (Unicode replacement character `\uFFFD`). O sistema captura a excecao e responde com mensagem de erro generica. Caracteres `\uFFFD` sao aceitos como texto valido — a limpeza de encoding nao e responsabilidade do InputHandler. |
| EC-11: PDF corrompido ou arquivo invalido | Usuario renomeou um `.exe` ou `.zip` para `.pdf`, ou o arquivo esta truncado. | `pdf-parse` lanca excecao de parse. O sistema captura e responde: "⚠️ Arquivo PDF invalido ou corrompido." e limpa o arquivo temporario. |

---

## 12. Segurança e Privacidade

- **Upload e Download Seguro:** Ao não salvar links externos nem exibir uploads localmente de forma compartilhada, asseguramos sandboxing.
- **Transcrições Locais:** A voz trafega end-to-end do telegram ao storage local e é consumida localmente sem ir para OpenAI Whisper cloud endpoints. Total controle de privacidade.

---

## 13. Plano de Rollout

A estrutura do `AudioHandler` acoplada ao Bot Core ficarão em produção local assim que instancializada no App() init() ou acopladas nas rules do `Composer.on("message:voice")`.

---

## 14. Open Questions (Resolvidos)

As perguntas abaixo foram resolvidas e suas decisões foram promovidas para a seção de requisitos (RF-05 e RF-07):

- **Q1 (Resolvida):** Invocação do Whisper via Node.js → Decisão: `child_process.execFile`. Ver RF-05.
- **Q2 (Resolvida):** Conversão de formato de áudio → Decisão: ffmpeg obrigatório. Ver RF-07.
