<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">Açık kaynaklı yapay zeka kodlama asistanı.</p>
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

### Kurulum

```bash
# YOLO
curl -fsSL https://0x0.ai/install | bash

# Paket yöneticileri
npm i -g 0x0-ai@latest        # veya bun/pnpm/yarn
scoop install 0x0             # Windows
choco install 0x0             # Windows
brew install anonymous-dev-org/tap/zeroxzero # macOS ve Linux (önerilir, her zaman güncel)
brew install 0x0              # macOS ve Linux (resmi brew formülü, daha az güncellenir)
paru -S 0x0-bin               # Arch Linux
mise use -g 0x0               # Tüm işletim sistemleri
nix run nixpkgs#0x0           # veya en güncel geliştirme dalı için github:anomalyco/0x0
```

> [!TIP]
> Kurulumdan önce 0.1.x'ten eski sürümleri kaldırın.

### Masaüstü Uygulaması (BETA)

Terminal Agent ayrıca masaüstü uygulaması olarak da mevcuttur. Doğrudan [sürüm sayfasından](https://github.com/anomalyco/0x0/releases) veya [0x0.ai/download](https://0x0.ai/download) adresinden indirebilirsiniz.

| Platform              | İndirme                               |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `0x0-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `0x0-desktop-darwin-x64.dmg`     |
| Windows               | `0x0-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` veya AppImage          |

```bash
# macOS (Homebrew)
brew install --cask 0x0-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/0x0-desktop
```

#### Kurulum Dizini (Installation Directory)

Kurulum betiği (install script), kurulum yolu (installation path) için aşağıdaki öncelik sırasını takip eder:

1. `$ZEROXZERO_INSTALL_DIR` - Özel kurulum dizini
2. `$XDG_BIN_DIR` - XDG Base Directory Specification uyumlu yol
3. `$HOME/bin` - Standart kullanıcı binary dizini (varsa veya oluşturulabiliyorsa)
4. `$HOME/.0x0/bin` - Varsayılan yedek konum

```bash
# Örnekler
ZEROXZERO_INSTALL_DIR=/usr/local/bin curl -fsSL https://0x0.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://0x0.ai/install | bash
```

### Ajanlar

Terminal Agent, `Tab` tuşuyla aralarında geçiş yapabileceğiniz iki yerleşik (built-in) ajan içerir.

- **build** - Varsayılan, geliştirme çalışmaları için tam erişimli ajan
- **plan** - Analiz ve kod keşfi için salt okunur ajan
  - Varsayılan olarak dosya düzenlemelerini reddeder
  - Bash komutlarını çalıştırmadan önce izin ister
  - Tanımadığınız kod tabanlarını keşfetmek veya değişiklikleri planlamak için ideal

Ayrıca, karmaşık aramalar ve çok adımlı görevler için bir **genel** alt ajan bulunmaktadır.
Bu dahili olarak kullanılır ve mesajlarda `@general` ile çağrılabilir.

[Ajanlar](https://0x0.ai/docs/agents) hakkında daha fazla bilgi edinin.

### Dokümantasyon

Terminal Agent'u nasıl yapılandıracağınız hakkında daha fazla bilgi için [**dokümantasyonumuza göz atın**](https://0x0.ai/docs).

### Katkıda Bulunma

Terminal Agent'a katkıda bulunmak istiyorsanız, lütfen bir pull request göndermeden önce [katkıda bulunma dokümanlarımızı](./CONTRIBUTING.md) okuyun.

### Terminal Agent Üzerine Geliştirme

Terminal Agent ile ilgili bir proje üzerinde çalışıyorsanız ve projenizin adının bir parçası olarak "0x0" kullanıyorsanız (örneğin, "0x0-dashboard" veya "0x0-mobile"), lütfen README dosyanıza projenin Terminal Agent ekibi tarafından geliştirilmediğini ve bizimle hiçbir şekilde bağlantılı olmadığını belirten bir not ekleyin.

### SSS

#### Bu Claude Code'dan nasıl farklı?

Yetenekler açısından Claude Code'a çok benzer. İşte temel farklar:

- %100 açık kaynak
- Herhangi bir sağlayıcıya bağlı değil. [Terminal Agent Zen](https://0x0.ai/zen) üzerinden sunduğumuz modelleri önermekle birlikte; Terminal Agent, Claude, OpenAI, Google veya hatta yerel modellerle kullanılabilir. Modeller geliştikçe aralarındaki farklar kapanacak ve fiyatlar düşecek, bu nedenle sağlayıcıdan bağımsız olmak önemlidir.
- Kurulum gerektirmeyen hazır LSP desteği
- TUI odaklı yaklaşım. Terminal Agent, neovim kullanıcıları ve [terminal.shop](https://terminal.shop)'un geliştiricileri tarafından geliştirilmektedir; terminalde olabileceklerin sınırlarını zorlayacağız.
- İstemci/sunucu (client/server) mimarisi. Bu, örneğin Terminal Agent'un bilgisayarınızda çalışması ve siz onu bir mobil uygulamadan uzaktan yönetmenizi sağlar. TUI arayüzü olası istemcilerden sadece biridir.

---

**Topluluğumuza katılın** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
