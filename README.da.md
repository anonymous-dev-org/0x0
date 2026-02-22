<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">Den open source AI-kodeagent.</p>
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

### Installation

```bash
npm i -g @anonymous-dev/0x0@latest        # eller bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS og Linux
```

### Agents

Terminal Agent har to indbyggede agents, som du kan skifte mellem med `Tab`-tasten.

- **build** - Standard, agent med fuld adgang til udviklingsarbejde
- **plan** - Skrivebeskyttet agent til analyse og kodeudforskning
  - Afviser filredigering som standard
  - Spørger om tilladelse før bash-kommandoer
  - Ideel til at udforske ukendte kodebaser eller planlægge ændringer

Derudover findes der en **general**-subagent til komplekse søgninger og flertrinsopgaver.
Den bruges internt og kan kaldes via `@general` i beskeder.

Læs mere om [agents](https://docs.anonymous.dev/packages/0x0-cli/agents).

### Dokumentation

For mere info om konfiguration af Terminal Agent, [**se vores docs**](https://docs.anonymous.dev/packages/0x0-cli).

### Bidrag

Hvis du vil bidrage til Terminal Agent, så læs vores [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygget på Terminal Agent

Hvis du arbejder på et projekt der bruger denne kodebase og genbruger dette branding, så tilføj en note i din README, der tydeliggør at projektet ikke er bygget af kerneteamet og ikke er tilknyttet os.

---

**Bliv en del af vores community** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
