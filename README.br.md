<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">O agente de programação com IA de código aberto.</p>
<p align="center">
  <a href="https://0x0.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/0x0-ai"><img alt="npm" src="https://img.shields.io/npm/v/0x0-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/0x0/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/0x0/publish.yml?style=flat-square&branch=dev" /></a>
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
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a>
</p>

[![Terminal Agent Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://0x0.ai)

---

### Instalação

```bash
# YOLO
curl -fsSL https://0x0.ai/install | bash

# Gerenciadores de pacotes
npm i -g 0x0-ai@latest        # ou bun/pnpm/yarn
scoop install 0x0             # Windows
choco install 0x0             # Windows
brew install anonymous-dev-org/tap/zeroxzero # macOS e Linux (recomendado, sempre atualizado)
brew install 0x0              # macOS e Linux (fórmula oficial do brew, atualiza menos)
paru -S 0x0-bin               # Arch Linux
mise use -g 0x0               # qualquer sistema
nix run nixpkgs#0x0           # ou github:anomalyco/0x0 para a branch dev mais recente
```

> [!TIP]
> Remova versões anteriores a 0.1.x antes de instalar.

### App desktop (BETA)

O Terminal Agent também está disponível como aplicativo desktop. Baixe diretamente pela [página de releases](https://github.com/anomalyco/0x0/releases) ou em [0x0.ai/download](https://0x0.ai/download).

| Plataforma            | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `0x0-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `0x0-desktop-darwin-x64.dmg`     |
| Windows               | `0x0-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` ou AppImage            |

```bash
# macOS (Homebrew)
brew install --cask 0x0-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/0x0-desktop
```

#### Diretório de instalação

O script de instalação respeita a seguinte ordem de prioridade para o caminho de instalação:

1. `$ZEROXZERO_INSTALL_DIR` - Diretório de instalação personalizado
2. `$XDG_BIN_DIR` - Caminho compatível com a especificação XDG Base Directory
3. `$HOME/bin` - Diretório binário padrão do usuário (se existir ou puder ser criado)
4. `$HOME/.0x0/bin` - Fallback padrão

```bash
# Exemplos
ZEROXZERO_INSTALL_DIR=/usr/local/bin curl -fsSL https://0x0.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://0x0.ai/install | bash
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

Saiba mais sobre [agents](https://0x0.ai/docs/agents).

### Documentação

Para mais informações sobre como configurar o Terminal Agent, [**veja nossa documentação**](https://0x0.ai/docs).

### Contribuir

Se você tem interesse em contribuir com o Terminal Agent, leia os [contributing docs](./CONTRIBUTING.md) antes de enviar um pull request.

### Construindo com Terminal Agent

Se você estiver trabalhando em um projeto relacionado ao Terminal Agent e estiver usando "0x0" como parte do nome (por exemplo, "0x0-dashboard" ou "0x0-mobile"), adicione uma nota no README para deixar claro que não foi construído pela equipe do Terminal Agent e não é afiliado a nós de nenhuma forma.

### FAQ

#### Como isso é diferente do Claude Code?

É muito parecido com o Claude Code em termos de capacidade. Aqui estão as principais diferenças:

- 100% open source
- Não está acoplado a nenhum provedor. Embora recomendemos os modelos que oferecemos pelo [Terminal Agent Zen](https://0x0.ai/zen); o Terminal Agent pode ser usado com Claude, OpenAI, Google ou até modelos locais. À medida que os modelos evoluem, as diferenças diminuem e os preços caem, então ser provider-agnostic é importante.
- Suporte a LSP pronto para uso
- Foco em TUI. O Terminal Agent é construído por usuários de neovim e pelos criadores do [terminal.shop](https://terminal.shop); vamos levar ao limite o que é possível no terminal.
- Arquitetura cliente/servidor. Isso, por exemplo, permite executar o Terminal Agent no seu computador enquanto você o controla remotamente por um aplicativo mobile. Isso significa que o frontend TUI é apenas um dos possíveis clientes.

---

**Junte-se à nossa comunidade** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
