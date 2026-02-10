<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">เอเจนต์การเขียนโค้ดด้วย AI แบบโอเพนซอร์ส</p>
<p align="center">
  <a href="https://0x0.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@anonymous-dev/0x0"><img alt="npm" src="https://img.shields.io/npm/v/@anonymous-dev/0x0?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/0x0/actions/workflows/publish.yml"><img alt="สถานะการสร้าง" src="https://img.shields.io/github/actions/workflow/status/anomalyco/0x0/publish.yml?style=flat-square&branch=dev" /></a>
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

### การติดตั้ง

```bash
# YOLO
curl -fsSL https://0x0.ai/install | bash

# ตัวจัดการแพ็กเกจ
npm i -g @anonymous-dev/0x0@latest        # หรือ bun/pnpm/yarn
scoop install 0x0             # Windows
choco install 0x0             # Windows
brew install anonymous-dev-org/tap/0x0 # macOS และ Linux (แนะนำ อัปเดตเสมอ)
brew install 0x0              # macOS และ Linux (brew formula อย่างเป็นทางการ อัปเดตน้อยกว่า)
paru -S 0x0-bin               # Arch Linux
mise use -g 0x0               # ระบบปฏิบัติการใดก็ได้
nix run nixpkgs#0x0           # หรือ github:anomalyco/0x0 สำหรับสาขาพัฒนาล่าสุด
```

> [!TIP]
> ลบเวอร์ชันที่เก่ากว่า 0.1.x ก่อนติดตั้ง

### แอปพลิเคชันเดสก์ท็อป (เบต้า)

Terminal Agent มีให้ใช้งานเป็นแอปพลิเคชันเดสก์ท็อป ดาวน์โหลดโดยตรงจาก [หน้ารุ่น](https://github.com/anomalyco/0x0/releases) หรือ [0x0.ai/download](https://0x0.ai/download)

| แพลตฟอร์ม             | ดาวน์โหลด                        |
| --------------------- | -------------------------------- |
| macOS (Apple Silicon) | `0x0-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `0x0-desktop-darwin-x64.dmg`     |
| Windows               | `0x0-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, หรือ AppImage    |

```bash
# macOS (Homebrew)
brew install --cask 0x0-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/0x0-desktop
```

#### ไดเรกทอรีการติดตั้ง

สคริปต์การติดตั้งจะใช้ลำดับความสำคัญตามเส้นทางการติดตั้ง:

1. `$ZEROXZERO_INSTALL_DIR` - ไดเรกทอรีการติดตั้งที่กำหนดเอง
2. `$XDG_BIN_DIR` - เส้นทางที่สอดคล้องกับ XDG Base Directory Specification
3. `$HOME/bin` - ไดเรกทอรีไบนารีผู้ใช้มาตรฐาน (หากมีอยู่หรือสามารถสร้างได้)
4. `$HOME/.0x0/bin` - ค่าสำรองเริ่มต้น

```bash
# ตัวอย่าง
ZEROXZERO_INSTALL_DIR=/usr/local/bin curl -fsSL https://0x0.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://0x0.ai/install | bash
```

### เอเจนต์

Terminal Agent รวมเอเจนต์ในตัวสองตัวที่คุณสามารถสลับได้ด้วยปุ่ม `Tab`

- **build** - เอเจนต์เริ่มต้น มีสิทธิ์เข้าถึงแบบเต็มสำหรับงานพัฒนา
- **plan** - เอเจนต์อ่านอย่างเดียวสำหรับการวิเคราะห์และการสำรวจโค้ด
  - ปฏิเสธการแก้ไขไฟล์โดยค่าเริ่มต้น
  - ขอสิทธิ์ก่อนเรียกใช้คำสั่ง bash
  - เหมาะสำหรับสำรวจโค้ดเบสที่ไม่คุ้นเคยหรือวางแผนการเปลี่ยนแปลง

นอกจากนี้ยังมีเอเจนต์ย่อย **general** สำหรับการค้นหาที่ซับซ้อนและงานหลายขั้นตอน
ใช้ภายในและสามารถเรียกใช้ได้โดยใช้ `@general` ในข้อความ

เรียนรู้เพิ่มเติมเกี่ยวกับ [เอเจนต์](https://0x0.ai/docs/agents)

### เอกสารประกอบ

สำหรับข้อมูลเพิ่มเติมเกี่ยวกับวิธีกำหนดค่า Terminal Agent [**ไปที่เอกสารของเรา**](https://0x0.ai/docs)

### การมีส่วนร่วม

หากคุณสนใจที่จะมีส่วนร่วมใน Terminal Agent โปรดอ่าน [เอกสารการมีส่วนร่วม](./CONTRIBUTING.md) ก่อนส่ง Pull Request

### การสร้างบน Terminal Agent

หากคุณทำงานในโปรเจกต์ที่เกี่ยวข้องกับ Terminal Agent และใช้ "0x0" เป็นส่วนหนึ่งของชื่อ เช่น "0x0-dashboard" หรือ "0x0-mobile" โปรดเพิ่มหมายเหตุใน README ของคุณเพื่อชี้แจงว่าไม่ได้สร้างโดยทีม Terminal Agent และไม่ได้เกี่ยวข้องกับเราในทางใด

### คำถามที่พบบ่อย

#### ต่างจาก Claude Code อย่างไร?

คล้ายกับ Claude Code มากในแง่ความสามารถ นี่คือความแตกต่างหลัก:

- โอเพนซอร์ส 100%
- ไม่ผูกมัดกับผู้ให้บริการใดๆ แม้ว่าเราจะแนะนำโมเดลที่เราจัดหาให้ผ่าน [Terminal Agent Zen](https://0x0.ai/zen) Terminal Agent สามารถใช้กับ Claude, OpenAI, Google หรือแม้กระทั่งโมเดลในเครื่องได้ เมื่อโมเดลพัฒนาช่องว่างระหว่างพวกมันจะปิดลงและราคาจะลดลง ดังนั้นการไม่ผูกมัดกับผู้ให้บริการจึงสำคัญ
- รองรับ LSP ใช้งานได้ทันทีหลังการติดตั้งโดยไม่ต้องปรับแต่งหรือเปลี่ยนแปลงฟังก์ชันการทำงานใด ๆ
- เน้นที่ TUI Terminal Agent สร้างโดยผู้ใช้ neovim และผู้สร้าง [terminal.shop](https://terminal.shop) เราจะผลักดันขีดจำกัดของสิ่งที่เป็นไปได้ในเทอร์มินัล
- สถาปัตยกรรมไคลเอนต์/เซิร์ฟเวอร์ ตัวอย่างเช่น อาจอนุญาตให้ Terminal Agent ทำงานบนคอมพิวเตอร์ของคุณ ในขณะที่คุณสามารถขับเคลื่อนจากระยะไกลผ่านแอปมือถือ หมายความว่า TUI frontend เป็นหนึ่งในไคลเอนต์ที่เป็นไปได้เท่านั้น

---

**ร่วมชุมชนของเรา** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
