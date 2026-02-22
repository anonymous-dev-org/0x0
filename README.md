<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">An open source AI coding agent.</p>
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
npm i -g @anonymous-dev/0x0@latest        # or bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS and Linux
```

### Agents

The CLI includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

It also includes a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://docs.anonymous.dev/packages/0x0-cli/agents).

### Documentation

For more info on configuration, [**head over to the docs**](https://docs.anonymous.dev/packages/0x0-cli).

### Contributing

If you're interested in contributing, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on Terminal Agent

If you are working on a project using this codebase and reusing this branding, please add a note to your README to clarify that it is not built by the core team and is not affiliated.

---

**Join our community** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
