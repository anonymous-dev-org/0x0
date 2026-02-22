<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">Terminal Agent je open source AI agent za programiranje.</p>
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

### Instalacija

```bash
npm i -g @anonymous-dev/0x0@latest        # ili bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS i Linux
```

### Agenti

Terminal Agent uključuje dva ugrađena agenta između kojih možeš prebacivati tasterom `Tab`.

- **build** - Podrazumijevani agent sa punim pristupom za razvoj
- **plan** - Agent samo za čitanje za analizu i istraživanje koda
  - Podrazumijevano zabranjuje izmjene datoteka
  - Traži dozvolu prije pokretanja bash komandi
  - Idealan za istraživanje nepoznatih codebase-ova ili planiranje izmjena

Uključen je i **general** pod-agent za složene pretrage i višekoračne zadatke.
Koristi se interno i može se pozvati pomoću `@general` u porukama.

Saznaj više o [agentima](https://docs.anonymous.dev/packages/0x0-cli/agents).

### Dokumentacija

Za više informacija o konfiguraciji Terminal Agent-a, [**pogledaj dokumentaciju**](https://docs.anonymous.dev/packages/0x0-cli).

### Doprinosi

Ako želiš doprinositi Terminal Agent-u, pročitaj [upute za doprinošenje](./CONTRIBUTING.md) prije slanja pull requesta.

### Gradnja na Terminal Agent-u

Ako radiš na projektu koji je povezan s Terminal Agent-om i koristi "0x0" kao dio naziva, npr. "0x0-dashboard" ili "0x0-mobile", dodaj napomenu u svoj README da projekat nije napravio Terminal Agent tim i da nije povezan s nama.

---

**Pridruži se našoj zajednici** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
