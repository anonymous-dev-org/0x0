<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">L'agent de codage IA open source.</p>
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
npm i -g @anonymous-dev/0x0@latest        # ou bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS et Linux
```

### Agents

Le CLI inclut deux agents intégrés que vous pouvez basculer avec la touche `Tab`.

- **build** - Par défaut, agent avec accès complet pour le travail de développement
- **plan** - Agent en lecture seule pour l'analyse et l'exploration du code
  - Refuse les modifications de fichiers par défaut
  - Demande l'autorisation avant d'exécuter des commandes bash
  - Idéal pour explorer une base de code inconnue ou planifier des changements

Un sous-agent **general** est aussi inclus pour les recherches complexes et les tâches en plusieurs étapes.
Il est utilisé en interne et peut être invoqué via `@general` dans les messages.

En savoir plus sur les [agents](https://docs.anonymous.dev/packages/0x0-cli/agents).

### Documentation

Pour plus d'informations sur la configuration, [**consultez notre documentation**](https://docs.anonymous.dev/packages/0x0-cli).

### Contribuer

Si vous souhaitez contribuer, lisez nos [docs de contribution](./CONTRIBUTING.md) avant de soumettre une pull request.

### Construire avec Terminal Agent

Si vous travaillez sur un projet utilisant cette base de code et réutilisant cette marque, ajoutez une note dans votre README pour préciser qu'il n'est pas construit par l'équipe principale et qu'il n'est pas affilié.

---

**Rejoignez notre communauté** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
