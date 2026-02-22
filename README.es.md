<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">El agente de programación con IA de código abierto.</p>
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

### Instalación

```bash
npm i -g @anonymous-dev/0x0@latest        # o bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS y Linux
```

### Agents

Terminal Agent incluye dos agents integrados que puedes alternar con la tecla `Tab`.

- **build** - Por defecto, agent con acceso completo para trabajo de desarrollo
- **plan** - Agent de solo lectura para análisis y exploración de código
  - Niega ediciones de archivos por defecto
  - Pide permiso antes de ejecutar comandos bash
  - Ideal para explorar codebases desconocidas o planificar cambios

Además, incluye un subagent **general** para búsquedas complejas y tareas de varios pasos.
Se usa internamente y se puede invocar con `@general` en los mensajes.

Más información sobre [agents](https://docs.anonymous.dev/packages/0x0-cli/agents).

### Documentación

Para más información sobre cómo configurar Terminal Agent, [**ve a nuestra documentación**](https://docs.anonymous.dev/packages/0x0-cli).

### Contribuir

Si te interesa contribuir a Terminal Agent, lee nuestras [docs de contribución](./CONTRIBUTING.md) antes de enviar un pull request.

### Construyendo sobre Terminal Agent

Si estás trabajando en un proyecto que usa este código y reutiliza esta marca, agrega una nota en tu README para aclarar que no está construido por el equipo principal y que no está afiliado.

---

**Únete a nuestra comunidad** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
