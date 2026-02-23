<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">O agente de programação com IA de código aberto.</p>
<p align="center">
  <a href="https://discord.gg"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@anonymous-dev/0x0"><img alt="npm" src="https://img.shields.io/npm/v/@anonymous-dev/0x0?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a>
</p>

---

### Instalação

```bash
npm i -g @anonymous-dev/0x0@latest        # ou bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS e Linux
```

### Agents

O Terminal Agent inclui dois agents integrados, que você pode alternar com a tecla `Tab`.

- **build** - Padrão, agent com acesso total para trabalho de desenvolvimento
- **plan** - Agent somente leitura para análise e exploração de código
  - Nega edições de arquivos por padrão
  - Pede permissão antes de executar comandos bash
  - Ideal para explorar codebases desconhecidas ou planejar mudanças

Também há um subagent **general** para buscas complexas e tarefas em várias etapas.
Ele é usado internamente e pode ser invocado com `@general` nas mensagens.

Saiba mais sobre [agents](https://docs.anonymous.dev/packages/0x0/agents).

### Documentação

Para mais informações sobre como configurar o Terminal Agent, [**veja nossa documentação**](https://docs.anonymous.dev/packages/0x0).

### Contribuir

Se você tem interesse em contribuir com o Terminal Agent, leia os [contributing docs](./CONTRIBUTING.md) antes de enviar um pull request.

### Construindo com Terminal Agent

Se você estiver trabalhando em um projeto usando esta base de código e reutilizando esta marca, adicione uma nota no seu README para deixar claro que não foi construído pela equipe principal e não é afiliado.

---

**Junte-se à nossa comunidade** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
