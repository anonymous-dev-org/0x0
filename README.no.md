<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">AI-kodeagent med åpen kildekode.</p>
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
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a>
</p>

---

### Installasjon

```bash
npm i -g @anonymous-dev/0x0@latest        # eller bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS og Linux
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

Les mer om [agents](https://docs.anonymous.dev/packages/0x0/agents).

### Dokumentasjon

For mer info om hvordan du konfigurerer Terminal Agent, [**se dokumentasjonen**](https://docs.anonymous.dev/packages/0x0).

### Bidra

Hvis du vil bidra til Terminal Agent, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på Terminal Agent

Hvis du jobber med et prosjekt som bruker denne kodebasen og gjenbruker denne merkevaren, legg inn en merknad i README som presiserer at det ikke er bygget av kjerneteamet og ikke er tilknyttet oss på noen måte.

---

**Bli med i fellesskapet** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
