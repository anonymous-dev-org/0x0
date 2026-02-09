<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">AI-kodeagent med åpen kildekode.</p>
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

### Installasjon

```bash
# YOLO
curl -fsSL https://0x0.ai/install | bash

# Pakkehåndterere
npm i -g 0x0-ai@latest        # eller bun/pnpm/yarn
scoop install 0x0             # Windows
choco install 0x0             # Windows
brew install anonymous-dev-org/tap/zeroxzero # macOS og Linux (anbefalt, alltid oppdatert)
brew install 0x0              # macOS og Linux (offisiell brew-formel, oppdateres sjeldnere)
paru -S 0x0-bin               # Arch Linux
mise use -g 0x0               # alle OS
nix run nixpkgs#0x0           # eller github:anomalyco/0x0 for nyeste dev-branch
```

> [!TIP]
> Fjern versjoner eldre enn 0.1.x før du installerer.

### Desktop-app (BETA)

Terminal Agent er også tilgjengelig som en desktop-app. Last ned direkte fra [releases-siden](https://github.com/anomalyco/0x0/releases) eller [0x0.ai/download](https://0x0.ai/download).

| Plattform             | Nedlasting                            |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `0x0-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `0x0-desktop-darwin-x64.dmg`     |
| Windows               | `0x0-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` eller AppImage         |

```bash
# macOS (Homebrew)
brew install --cask 0x0-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/0x0-desktop
```

#### Installasjonsmappe

Installasjonsskriptet bruker følgende prioritet for installasjonsstien:

1. `$ZEROXZERO_INSTALL_DIR` - Egendefinert installasjonsmappe
2. `$XDG_BIN_DIR` - Sti som følger XDG Base Directory Specification
3. `$HOME/bin` - Standard brukerbinar-mappe (hvis den finnes eller kan opprettes)
4. `$HOME/.0x0/bin` - Standard fallback

```bash
# Eksempler
ZEROXZERO_INSTALL_DIR=/usr/local/bin curl -fsSL https://0x0.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://0x0.ai/install | bash
```

### Agents

Terminal Agent har to innebygde agents du kan bytte mellom med `Tab`-tasten.

- **build** - Standard, agent med full tilgang for utviklingsarbeid
- **plan** - Skrivebeskyttet agent for analyse og kodeutforsking
  - Nekter filendringer som standard
  - Spør om tillatelse før bash-kommandoer
  - Ideell for å utforske ukjente kodebaser eller planlegge endringer

Det finnes også en **general**-subagent for komplekse søk og flertrinnsoppgaver.
Den brukes internt og kan kalles via `@general` i meldinger.

Les mer om [agents](https://0x0.ai/docs/agents).

### Dokumentasjon

For mer info om hvordan du konfigurerer Terminal Agent, [**se dokumentasjonen**](https://0x0.ai/docs).

### Bidra

Hvis du vil bidra til Terminal Agent, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på Terminal Agent

Hvis du jobber med et prosjekt som er relatert til Terminal Agent og bruker "0x0" som en del av navnet; for eksempel "0x0-dashboard" eller "0x0-mobile", legg inn en merknad i README som presiserer at det ikke er bygget av Terminal Agent-teamet og ikke er tilknyttet oss på noen måte.

### FAQ

#### Hvordan er dette forskjellig fra Claude Code?

Det er veldig likt Claude Code når det gjelder funksjonalitet. Her er de viktigste forskjellene:

- 100% open source
- Ikke knyttet til en bestemt leverandør. Selv om vi anbefaler modellene vi tilbyr gjennom [Terminal Agent Zen](https://0x0.ai/zen); kan Terminal Agent brukes med Claude, OpenAI, Google eller til og med lokale modeller. Etter hvert som modellene utvikler seg vil gapene lukkes og prisene gå ned, så det er viktig å være provider-agnostic.
- LSP-støtte rett ut av boksen
- Fokus på TUI. Terminal Agent er bygget av neovim-brukere og skaperne av [terminal.shop](https://terminal.shop); vi kommer til å presse grensene for hva som er mulig i terminalen.
- Klient/server-arkitektur. Dette kan for eksempel la Terminal Agent kjøre på maskinen din, mens du styrer den eksternt fra en mobilapp. Det betyr at TUI-frontend'en bare er en av de mulige klientene.

---

**Bli med i fellesskapet** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
