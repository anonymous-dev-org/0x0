<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">Otwartoźródłowy agent kodujący AI.</p>
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

### Instalacja

```bash
# YOLO
curl -fsSL https://0x0.ai/install | bash

# Menedżery pakietów
npm i -g 0x0-ai@latest        # albo bun/pnpm/yarn
scoop install 0x0             # Windows
choco install 0x0             # Windows
brew install anonymous-dev-org/tap/zeroxzero # macOS i Linux (polecane, zawsze aktualne)
brew install 0x0              # macOS i Linux (oficjalna formuła brew, rzadziej aktualizowana)
paru -S 0x0-bin               # Arch Linux
mise use -g 0x0               # dowolny system
nix run nixpkgs#0x0           # lub github:anomalyco/0x0 dla najnowszej gałęzi dev
```

> [!TIP]
> Przed instalacją usuń wersje starsze niż 0.1.x.

### Aplikacja desktopowa (BETA)

Terminal Agent jest także dostępny jako aplikacja desktopowa. Pobierz ją bezpośrednio ze strony [releases](https://github.com/anomalyco/0x0/releases) lub z [0x0.ai/download](https://0x0.ai/download).

| Platforma             | Pobieranie                            |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `0x0-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `0x0-desktop-darwin-x64.dmg`     |
| Windows               | `0x0-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` lub AppImage           |

```bash
# macOS (Homebrew)
brew install --cask 0x0-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/0x0-desktop
```

#### Katalog instalacji

Skrypt instalacyjny stosuje następujący priorytet wyboru ścieżki instalacji:

1. `$ZEROXZERO_INSTALL_DIR` - Własny katalog instalacji
2. `$XDG_BIN_DIR` - Ścieżka zgodna ze specyfikacją XDG Base Directory
3. `$HOME/bin` - Standardowy katalog binarny użytkownika (jeśli istnieje lub można go utworzyć)
4. `$HOME/.0x0/bin` - Domyślny fallback

```bash
# Przykłady
ZEROXZERO_INSTALL_DIR=/usr/local/bin curl -fsSL https://0x0.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://0x0.ai/install | bash
```

### Agents

Terminal Agent zawiera dwóch wbudowanych agentów, między którymi możesz przełączać się klawiszem `Tab`.

- **build** - Domyślny agent z pełnym dostępem do pracy developerskiej
- **plan** - Agent tylko do odczytu do analizy i eksploracji kodu
  - Domyślnie odmawia edycji plików
  - Pyta o zgodę przed uruchomieniem komend bash
  - Idealny do poznawania nieznanych baz kodu lub planowania zmian

Dodatkowo jest subagent **general** do złożonych wyszukiwań i wieloetapowych zadań.
Jest używany wewnętrznie i można go wywołać w wiadomościach przez `@general`.

Dowiedz się więcej o [agents](https://0x0.ai/docs/agents).

### Dokumentacja

Więcej informacji o konfiguracji Terminal Agent znajdziesz w [**dokumentacji**](https://0x0.ai/docs).

### Współtworzenie

Jeśli chcesz współtworzyć Terminal Agent, przeczytaj [contributing docs](./CONTRIBUTING.md) przed wysłaniem pull requesta.

### Budowanie na Terminal Agent

Jeśli pracujesz nad projektem związanym z Terminal Agent i używasz "0x0" jako części nazwy (na przykład "0x0-dashboard" lub "0x0-mobile"), dodaj proszę notatkę do swojego README, aby wyjaśnić, że projekt nie jest tworzony przez zespół Terminal Agent i nie jest z nami w żaden sposób powiązany.

### FAQ

#### Czym to się różni od Claude Code?

Jest bardzo podobne do Claude Code pod względem możliwości. Oto kluczowe różnice:

- 100% open source
- Niezależne od dostawcy. Chociaż polecamy modele oferowane przez [Terminal Agent Zen](https://0x0.ai/zen); Terminal Agent może być używany z Claude, OpenAI, Google, a nawet z modelami lokalnymi. W miarę jak modele ewoluują, różnice będą się zmniejszać, a ceny spadać, więc ważna jest niezależność od dostawcy.
- Wbudowane wsparcie LSP
- Skupienie na TUI. Terminal Agent jest budowany przez użytkowników neovim i twórców [terminal.shop](https://terminal.shop); przesuwamy granice tego, co jest możliwe w terminalu.
- Architektura klient/serwer. Pozwala np. uruchomić Terminal Agent na twoim komputerze, a sterować nim zdalnie z aplikacji mobilnej. To znaczy, że frontend TUI jest tylko jednym z możliwych klientów.

---

**Dołącz do naszej społeczności** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
