<p align="center"><strong>Terminal Agent</strong></p>
<p align="center">오픈 소스 AI 코딩 에이전트.</p>
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

### 설치

```bash
npm i -g @anonymous-dev/0x0@latest        # bun/pnpm/yarn 도 가능
brew install anonymous-dev-org/tap/0x0 # macOS 및 Linux
```

### Agents

Terminal Agent 에는 내장 에이전트 2개가 있으며 `Tab` 키로 전환할 수 있습니다.

- **build** - 기본값, 개발 작업을 위한 전체 권한 에이전트
- **plan** - 분석 및 코드 탐색을 위한 읽기 전용 에이전트
  - 기본적으로 파일 편집을 거부
  - bash 명령 실행 전에 권한을 요청
  - 낯선 코드베이스를 탐색하거나 변경을 계획할 때 적합

또한 복잡한 검색과 여러 단계 작업을 위한 **general** 서브 에이전트가 포함되어 있습니다.
내부적으로 사용되며, 메시지에서 `@general` 로 호출할 수 있습니다.

[agents](https://docs.anonymous.dev/packages/0x0-cli/agents) 에 대해 더 알아보세요.

### 문서

Terminal Agent 설정에 대한 자세한 내용은 [**문서**](https://docs.anonymous.dev/packages/0x0-cli) 를 참고하세요.

### 기여하기

Terminal Agent 에 기여하고 싶다면, Pull Request 를 제출하기 전에 [contributing docs](./CONTRIBUTING.md) 를 읽어주세요.

### Terminal Agent 기반으로 만들기

Terminal Agent 와 관련된 프로젝트를 진행하면서 이 브랜딩을 재사용한다면, README 에 해당 프로젝트가 핵심 팀이 만든 것이 아니며 어떤 방식으로도 제휴되어 있지 않다는 점을 명시해 주세요.

---

**커뮤니티에 참여하기** [Discord](https://discord.gg/0x0) | [X.com](https://x.com/0x0)
