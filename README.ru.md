<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">Открытый AI-агент для программирования.</p>
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

### Установка

```bash
npm i -g @anonymous-dev/0x0@latest        # или bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS и Linux
```

### Agents

В Terminal Agent есть два встроенных агента, между которыми можно переключаться клавишей `Tab`.

- **build** - По умолчанию, агент с полным доступом для разработки
- **plan** - Агент только для чтения для анализа и изучения кода
  - По умолчанию запрещает редактирование файлов
  - Запрашивает разрешение перед выполнением bash-команд
  - Идеален для изучения незнакомых кодовых баз или планирования изменений

Также включен сабагент **general** для сложных поисков и многошаговых задач.
Он используется внутренне и может быть вызван в сообщениях через `@general`.

Подробнее об [agents](https://docs.anonymous.dev/packages/0x0-cli/agents).

### Документация

Больше информации о том, как настроить Terminal Agent: [**наши docs**](https://docs.anonymous.dev/packages/0x0-cli).

### Вклад

Если вы хотите внести вклад в Terminal Agent, прочитайте [contributing docs](./CONTRIBUTING.md) перед тем, как отправлять pull request.

### Разработка на базе Terminal Agent

Если вы делаете проект, связанный с Terminal Agent, и используете "0x0" как часть имени (например, "0x0-dashboard" или "0x0-mobile"), добавьте примечание в README, чтобы уточнить, что проект не создан командой Terminal Agent и не аффилирован с нами.

---

**Присоединяйтесь к нашему сообществу** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
