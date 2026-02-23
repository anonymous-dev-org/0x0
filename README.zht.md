<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">開源的 AI Coding Agent。</p>
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

### 安裝

```bash
npm i -g @anonymous-dev/0x0@latest        # 也可使用 bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS 與 Linux
```

### Agents

Terminal Agent 內建了兩種 Agent，您可以使用 `Tab` 鍵快速切換。

- **build** - 預設模式，具備完整權限的 Agent，適用於開發工作。
- **plan** - 唯讀模式，適用於程式碼分析與探索。
  - 預設禁止修改檔案。
  - 執行 bash 指令前會詢問權限。
  - 非常適合用來探索陌生的程式碼庫或規劃變更。

此外，Terminal Agent 還包含一個 **general** 子 Agent，用於處理複雜搜尋與多步驟任務。此 Agent 供系統內部使用，亦可透過在訊息中輸入 `@general` 來呼叫。

了解更多關於 [Agents](https://docs.anonymous.dev/packages/0x0/agents) 的資訊。

### 線上文件

關於如何設定 Terminal Agent 的詳細資訊，請參閱我們的 [**官方文件**](https://docs.anonymous.dev/packages/0x0)。

### 參與貢獻

如果您有興趣參與 Terminal Agent 的開發，請在提交 Pull Request 前先閱讀我們的 [貢獻指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 基於 Terminal Agent 進行開發

如果您正在開發與 Terminal Agent 相關的專案，並在名稱中使用了 "0x0"（例如 "0x0-dashboard" 或 "0x0-mobile"），請在您的 README 中加入聲明，說明該專案並非由 Terminal Agent 團隊開發，且與我們沒有任何隸屬關係。

---

**加入我們的社群** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
