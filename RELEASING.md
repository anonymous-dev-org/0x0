# Release ops

Practical steps for shipping 0x0 safely.

---

## Choose version

- Use SemVer for stable tags: patch for fixes, minor for backward-compatible features, major for breaking changes.
- Keep one version across GitHub tag, release assets, npm packages, and Homebrew formula.
- Format the Git tag as `vX.Y.Z`, and pass `X.Y.Z` (without `v`) to scripts that ask for `--version`.
- If you want an automated bump suggestion from existing releases, run `bun ./script/publish-tap.ts --bump patch --no-push` and read the computed version.

---

## Build artifacts

- Build from source with `bun ./packages/0x0/script/build.ts`.
- This generates platform packages under `packages/0x0/dist/*` and archives in `packages/0x0/dist/*.zip` and `packages/0x0/dist/*.tar.gz`.
- Default build targets include Linux (glibc, musl, baseline variants), macOS (arm64, x64, x64-baseline), and Windows (x64, x64-baseline).
- Use `--single` only for local checks, because publishing needs the full multi-platform output.

---

## Publish on GitHub

- Create or update a non-draft, publicly visible release with tag `vX.Y.Z` in the main repo.
- Draft releases are not downloadable by the tap workflow and cause 404 errors during `gh release download`.
- Required asset names for tap publishing are:
  - `0x0-darwin-arm64.zip`
  - `0x0-darwin-x64.zip`
  - `0x0-linux-arm64.tar.gz`
  - `0x0-linux-x64.tar.gz`
- Upload all generated archives when possible, but ensure the four required names above are present exactly.

---

## Publish on npm

- Use the manual sequential publisher: `bun ./packages/0x0/script/publish-npm-manual.ts --scope @anonymous-dev --tag latest`.
- This publishes `@anonymous-dev/0x0` plus platform packages from `packages/0x0/dist` one by one.
- Expected platform package names are:
  - `@anonymous-dev/0x0-linux-x64-baseline`
  - `@anonymous-dev/0x0-linux-x64`
  - `@anonymous-dev/0x0-darwin-arm64`
  - `@anonymous-dev/0x0-darwin-x64-baseline`
  - `@anonymous-dev/0x0-darwin-x64`
  - `@anonymous-dev/0x0-windows-x64`
  - `@anonymous-dev/0x0-linux-x64-baseline-musl`
  - `@anonymous-dev/0x0-linux-arm64`
  - `@anonymous-dev/0x0-linux-arm64-musl`
  - `@anonymous-dev/0x0-windows-x64-baseline`
  - `@anonymous-dev/0x0-linux-x64-musl`
- If npm requests passkey/web auth or returns `EOTP`, run `npm login --scope=@anonymous-dev --auth-type=web` and rerun.
- If you use TOTP, pass it directly with `--otp <code>`.

---

## Publish on Homebrew tap

- Tap publishing writes `Formula/zeroxzero.rb` and `Aliases/0x0` in the tap repo.
- Run `bun ./script/publish-tap.ts --version X.Y.Z` after the GitHub release is live and has required assets.
- Keep the Ruby class as `Zeroxzero`, because formula classes cannot start with a number.
- Keep binary mapping as `bin.install "zeroxzero" => "0x0"`, so installed command is `0x0`.

---

## Verify delivery

- Check release assets are reachable: `curl -fL -I https://github.com/anonymous-dev-org/0x0/releases/download/vX.Y.Z/0x0-darwin-arm64.zip`.
- Install from tap: `brew tap anonymous-dev-org/homebrew-tap && brew install 0x0`.
- Verify versions: `0x0 --version`, `npm view @anonymous-dev/0x0@X.Y.Z version`, and `brew info 0x0`.
- Check path precedence with `which -a 0x0` if version output is unexpected.
- If an older binary appears first in `PATH`, unlink or remove it before validating again.

---

## Fix common issues

- GitHub asset 404 during tap publish usually means release is draft/private or the asset name is wrong.
- Homebrew class mismatch happens when class name and formula file naming drift; keep `class Zeroxzero < Formula` in `Formula/zeroxzero.rb`.
- Wrong command name after brew install means missing rename mapping; keep `"zeroxzero" => "0x0"` in every install block.
- npm publish failures with `EOTP` or token expiration are auth issues; do web login again or pass a fresh `--otp`.

---

## Run checklist

```bash
set -euo pipefail

V="X.Y.Z"
REPO="anonymous-dev-org/0x0"

# 1) Build all platform artifacts
bun ./packages/0x0/script/build.ts

# 2) Create public non-draft release if missing
gh release view "v$V" --repo "$REPO" >/dev/null 2>&1 || \
  gh release create "v$V" --repo "$REPO" --title "v$V" --notes "Release v$V"

# 3) Upload archives (required tap assets must exist)
gh release upload "v$V" ./packages/0x0/dist/*.zip ./packages/0x0/dist/*.tar.gz --repo "$REPO" --clobber

# 4) Publish npm packages sequentially
bun ./packages/0x0/script/publish-npm-manual.ts --scope @anonymous-dev --tag latest --version "$V"

# 5) Publish tap formula + alias
bun ./script/publish-tap.ts --version "$V"

# 6) Verify delivery
curl -fL -I "https://github.com/$REPO/releases/download/v$V/0x0-darwin-arm64.zip"
npm view "@anonymous-dev/0x0@$V" version
brew tap anonymous-dev-org/homebrew-tap
brew install 0x0 || brew upgrade 0x0
0x0 --version
which -a 0x0
```
