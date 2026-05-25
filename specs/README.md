# GeneriClaw Specifications

Documentacao de especificacao do sistema GeneriClaw. Cada arquivo define o contrato, interface, edge cases e dependencias de um modulo.

## Suggested Reading Order

1. **PRD.md** — Metas do projeto, escopo, metricas de sucesso
2. **architecture.md** — Visao geral do sistema, componentes, stack, estrutura de diretorios
3. **configuration.md** — Variaveis de ambiente, validacao, modulo config.ts
4. **bootstrap.md** — Sequencia de inicializacao e shutdown
5. **agent-controller.md** — Facade que orquestra o pipeline completo
6. **agent-loop.md** — Motor de raciocinio ReAct
7. **memory.md** — Schema do banco SQLite, repositorios, persistencia
8. **memory-manager.md** — Facade de persistencia (truncamento, janela de contexto)
9. **llm-provider.md** — Abstracao de provedores LLM, fallback, retry
10. **tools.md** — Registry de ferramentas executaveis, ToolFactory
11. **core-tools.md** — Ferramentas de filesystem (criar_arquivo, ler_arquivo, listar_arquivos)
12. **skill-user.md** — Sistema de skills (hot-reload, SkillLoader, SkillRouter)
13. **telegram-input.md** — Entrada via Telegram (texto, voz, documentos, STT)
14. **telegram-output.md** — Saida via Telegram (texto, arquivos, audio TTS)

## Files Summary

| File | Module | Description |
|------|--------|-------------|
| PRD.md | Product Requirements | Project goals, scope, non-goals, rollout |
| architecture.md | System Architecture | Components, layers, tech stack, directory structure |
| configuration.md | Configuration | Environment variables, validation, AppConfig |
| bootstrap.md | Bootstrap | Initialization order, shutdown sequence |
| agent-controller.md | AgentController | Pipeline facade, system prompt assembly |
| agent-loop.md | AgentLoop | ReAct reasoning engine, tool call execution |
| memory.md | Memory | SQLite schema, repository interfaces |
| memory-manager.md | MemoryManager | Persistence facade, context window truncation |
| llm-provider.md | LLM Providers | Provider abstraction, fallback, retry logic |
| tools.md | Tool Registry | Tool interface, registry, factory |
| core-tools.md | Core Tools | Filesystem tools (criar, ler, listar arquivos) |
| skill-user.md | Skill System | Hot-reload skills, loader, router |
| telegram-input.md | Telegram Input | Message handling, voice STT, document parsing |
| telegram-output.md | Telegram Output | Output strategies, chunking, TTS, file output |
