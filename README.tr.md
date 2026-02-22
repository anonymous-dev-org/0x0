<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">Açık kaynaklı yapay zeka kodlama asistanı.</p>
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

### Kurulum

```bash
npm i -g @anonymous-dev/0x0@latest        # veya bun/pnpm/yarn
brew install anonymous-dev-org/tap/0x0 # macOS ve Linux
```

### Ajanlar

CLI, `Tab` tuşuyla aralarında geçiş yapabileceğiniz iki yerleşik ajan içerir.

- **build** - Varsayılan, geliştirme çalışmaları için tam erişimli ajan
- **plan** - Analiz ve kod keşfi için salt okunur ajan
  - Varsayılan olarak dosya düzenlemelerini reddeder
  - Bash komutlarını çalıştırmadan önce izin ister
  - Tanımadığınız kod tabanlarını keşfetmek veya değişiklikleri planlamak için ideal

Ayrıca, karmaşık aramalar ve çok adımlı görevler için bir **genel** alt ajan bulunmaktadır.
Bu dahili olarak kullanılır ve mesajlarda `@general` ile çağrılabilir.

[Ajanlar](https://docs.anonymous.dev/packages/0x0-cli/agents) hakkında daha fazla bilgi edinin.

### Dokümantasyon

Yapılandırma hakkında daha fazla bilgi için [**dokümantasyonumuza göz atın**](https://docs.anonymous.dev/packages/0x0-cli).

### Katkıda Bulunma

Terminal Agent'a katkıda bulunmak istiyorsanız, lütfen bir pull request göndermeden önce [katkıda bulunma dokümanlarımızı](./CONTRIBUTING.md) okuyun.

### Terminal Agent Üzerine Geliştirme

Bu kod tabanını kullanan ve bu markayı yeniden kullanan bir proje üzerinde çalışıyorsanız, lütfen README dosyanıza projenin çekirdek ekip tarafından geliştirilmediğini ve bizimle bağlantılı olmadığını belirten bir not ekleyin.

---

**Topluluğumuza katılın** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
