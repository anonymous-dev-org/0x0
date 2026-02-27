#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-anonymous-dev-org/0x0}"
SCOPE="${SCOPE:-@anonymous-dev}"
NPM_TAG="${NPM_TAG:-latest}"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: ./script/release-local.sh [--dry-run]

Unified release for all packages. Each package has its own version.
Prompts for version per package, then publishes everything.

Packages:
  0x0              → npm + brew (zeroxzero)
  0x0-git          → npm + brew (zeroxzero-git)
  nvim             → git repo push
  nvim-completion  → git repo push

Options:
  --dry-run   Print planned publish commands without executing mutating steps
  -h, --help  Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1"
    exit 1
  }
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY RUN: '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

semver_from_tag() {
  local t="$1"
  echo "${t#v}"
}

bump_version() {
  local v="$1"
  local t="$2"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$v"

  case "$t" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "${major}.$((minor + 1)).0" ;;
    patch) echo "${major}.${minor}.$((patch + 1))" ;;
    *) echo "invalid"; return 1 ;;
  esac
}

is_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

set_pkg_version() {
  local file="$1"
  local ver="$2"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: set $file version to $ver"
    return
  fi
  FILE="$file" VER="$ver" bun -e '
    const f = process.env.FILE!
    const v = process.env.VER!
    const p = await Bun.file(f).json()
    p.version = v
    await Bun.write(f, JSON.stringify(p, null, 2) + "\n")
    console.log(`Updated ${f} to ${v}`)
  '
}

semver_gt() {
  local a="$1"
  local b="$2"
  local a_major a_minor a_patch b_major b_minor b_patch
  IFS='.' read -r a_major a_minor a_patch <<< "$a"
  IFS='.' read -r b_major b_minor b_patch <<< "$b"

  if ((a_major > b_major)); then
    return 0
  fi
  if ((a_major < b_major)); then
    return 1
  fi
  if ((a_minor > b_minor)); then
    return 0
  fi
  if ((a_minor < b_minor)); then
    return 1
  fi
  ((a_patch > b_patch))
}

pick_latest_tag() {
  local best=""
  local tag=""
  local version=""

  for tag in $(git tag --list 'v[0-9]*.[0-9]*.[0-9]*'); do
    version="$(semver_from_tag "$tag")"
    if ! is_semver "$version"; then
      continue
    fi
    if [[ -z "$best" ]] || semver_gt "$version" "$best"; then
      best="$version"
    fi
  done

  while IFS= read -r tag; do
    [[ -n "$tag" && "$tag" != "null" ]] || continue
    version="$(semver_from_tag "$tag")"
    if ! is_semver "$version"; then
      continue
    fi
    if [[ -z "$best" ]] || semver_gt "$version" "$best"; then
      best="$version"
    fi
  done < <(gh release list --repo "$REPO" --limit 200 --json tagName --jq '.[].tagName' 2>/dev/null || true)

  if [[ -n "$best" ]]; then
    echo "v$best"
  fi
}

package_if_needed() {
  local name="$1"
  local mode="$2"
  local pkg_dir="${3:-./packages/tui}"
  local src="${pkg_dir}/dist/${name}/bin"
  local out="${pkg_dir}/dist/${name}"

  [[ -d "$src" ]] || return 0

  if [[ "$mode" == "zip" && ! -f "${out}.zip" ]]; then
    run bash -lc "cd '$src' && zip -r '../../${name}.zip' *"
  fi

  if [[ "$mode" == "tgz" && ! -f "${out}.tar.gz" ]]; then
    run bash -lc "cd '$src' && tar -czf '../../${name}.tar.gz' *"
  fi
}

prepare_npm_dist() {
  local version="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: prepare scoped dist package metadata"
    return
  fi

  run rm -rf ./packages/tui/dist/0x0
  run mkdir -p ./packages/tui/dist/0x0
  run cp -r ./packages/tui/bin ./packages/tui/dist/0x0/bin
  run cp ./packages/tui/script/postinstall.mjs ./packages/tui/dist/0x0/postinstall.mjs
  run cp ./LICENSE ./packages/tui/dist/0x0/LICENSE

  SCOPE="$SCOPE" VERSION="$version" bun -e '
    const scope = process.env.SCOPE
    if (!scope) throw new Error("Missing SCOPE")

    const pkg = await Bun.file("./packages/tui/package.json").json()
    const dist = "./packages/tui/dist"
    const release = process.env.VERSION
    if (!release) throw new Error("Missing VERSION")
    const binaries = {}
    const dirs = []

    for await (const filepath of new Bun.Glob("*/package.json").scan({ cwd: dist })) {
      const dir = filepath.split("/")[0]
      if (!dir || dir === pkg.name) continue

      const file = `${dist}/${filepath}`
      const info = await Bun.file(file).json()
      binaries[dir] = release
      dirs.push(dir)
      await Bun.write(
        file,
        JSON.stringify(
          {
            ...info,
            name: `${scope}/${dir}`,
            version: release,
          },
          null,
          2,
        ) + "\n",
      )
    }

    const version = Object.values(binaries)[0]
    if (!version) throw new Error("No built binaries found in ./packages/tui/dist")

    const optionalDependencies = Object.fromEntries(
      Object.entries(binaries).map(([name, value]) => [`${scope}/${name}`, value]),
    )

    await Bun.write(
      `${dist}/${pkg.name}/package.json`,
      JSON.stringify(
        {
          name: `${scope}/${pkg.name}`,
          bin: {
            [pkg.name]: `./bin/${pkg.name}`,
          },
          scripts: {
            postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
          },
          version,
          license: pkg.license,
          optionalDependencies,
        },
        null,
        2,
      ) + "\n",
    )

    console.log(`Prepared dist metadata for ${dirs.length} binaries at version ${version}`)
  '
}

prepare_git_npm_dist() {
  local version="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: prepare scoped git dist package metadata"
    return
  fi

  run rm -rf ./packages/git/dist/0x0-git
  run mkdir -p ./packages/git/dist/0x0-git
  run cp -r ./packages/git/bin ./packages/git/dist/0x0-git/bin
  run cp ./packages/git/script/postinstall.mjs ./packages/git/dist/0x0-git/postinstall.mjs
  run cp ./LICENSE ./packages/git/dist/0x0-git/LICENSE

  SCOPE="$SCOPE" VERSION="$version" bun -e '
    const scope = process.env.SCOPE
    if (!scope) throw new Error("Missing SCOPE")

    const dist = "./packages/git/dist"
    const release = process.env.VERSION
    if (!release) throw new Error("Missing VERSION")
    const binaries = {}
    const dirs = []

    for await (const filepath of new Bun.Glob("*/package.json").scan({ cwd: dist })) {
      const dir = filepath.split("/")[0]
      if (!dir || dir === "0x0-git") continue

      const file = `${dist}/${filepath}`
      const info = await Bun.file(file).json()
      binaries[dir] = release
      dirs.push(dir)
      await Bun.write(
        file,
        JSON.stringify(
          {
            ...info,
            name: `${scope}/${dir}`,
            version: release,
          },
          null,
          2,
        ) + "\n",
      )
    }

    const version = Object.values(binaries)[0]
    if (!version) throw new Error("No built binaries found in ./packages/git/dist")

    const optionalDependencies = Object.fromEntries(
      Object.entries(binaries).map(([name, value]) => [`${scope}/${name}`, value]),
    )

    await Bun.write(
      `${dist}/0x0-git/package.json`,
      JSON.stringify(
        {
          name: `${scope}/0x0-git`,
          bin: {
            "0x0-git": "./bin/0x0-git",
          },
          scripts: {
            postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
          },
          version,
          license: "MIT",
          optionalDependencies,
        },
        null,
        2,
      ) + "\n",
    )

    console.log(`Prepared git dist metadata for ${dirs.length} binaries at version ${version}`)
  '
}

# ── Preflight ──────────────────────────────────────────────────────

need_cmd git
need_cmd bun
need_cmd gh
need_cmd npm
need_cmd curl
need_cmd zip
need_cmd tar

[[ -f "./packages/tui/script/build.ts" ]] || {
  echo "Run this from repo root."
  exit 1
}

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login"
  exit 1
fi

# ── Version prompts (per package) ──────────────────────────────────

# 0x0 version — from git tags
latest_tag="$(pick_latest_tag)"
if [[ -z "${latest_tag}" ]]; then
  echo "No semver tags or releases found. Start from 0.0.0."
  latest_tag="v0.0.0"
fi
latest_version="$(semver_from_tag "$latest_tag")"

echo "── 0x0 (server/TUI) ──"
echo "Latest tag: ${latest_tag}"
echo "Select release type:"
select release_type in major minor patch; do
  [[ -n "${release_type:-}" ]] && break
  echo "Choose 1, 2, or 3."
done
next_version="$(bump_version "$latest_version" "$release_type")"
read -r -p "0x0 version [${next_version}]: " override
VERSION_0X0="${override:-$next_version}"
is_semver "$VERSION_0X0" || { echo "Invalid version: $VERSION_0X0"; exit 1; }

# 0x0-git version — from package.json
GIT_PKG_VERSION="$(bun -e 'const p = await Bun.file("./packages/git/package.json").json(); console.log(p.version)')"
echo
echo "── 0x0-git ──"
echo "Current package.json version: ${GIT_PKG_VERSION}"
echo "Select release type:"
select git_release_type in major minor patch same; do
  [[ -n "${git_release_type:-}" ]] && break
  echo "Choose 1, 2, 3, or 4."
done
if [[ "$git_release_type" == "same" ]]; then
  next_git_version="$GIT_PKG_VERSION"
else
  next_git_version="$(bump_version "$GIT_PKG_VERSION" "$git_release_type")"
fi
read -r -p "0x0-git version [${next_git_version}]: " git_override
VERSION_GIT="${git_override:-$next_git_version}"
is_semver "$VERSION_GIT" || { echo "Invalid version: $VERSION_GIT"; exit 1; }

# nvim versions — read from local version.txt files

prompt_nvim_version() {
  local label="$1"
  local version_file="$2"
  local result_var="$3"

  echo
  echo "── ${label} ──"

  local current=""
  if [[ -f "$version_file" ]]; then
    current="$(tr -d '[:space:]' < "$version_file")"
  fi

  if [[ -z "$current" ]] || ! is_semver "$current"; then
    echo "No valid version found in ${version_file}."
    echo "Select release type:"
    select nvim_type in skip "start at 0.1.0"; do
      case "$nvim_type" in
        skip) eval "$result_var=''"; return ;;
        "start at 0.1.0") eval "$result_var='0.1.0'"; return ;;
        *) echo "Choose 1 or 2." ;;
      esac
    done
  else
    echo "Current version: v${current}  (from ${version_file})"
    echo "Select release type:"
    select nvim_type in major minor patch skip; do
      [[ -n "${nvim_type:-}" ]] && break
      echo "Choose 1, 2, 3, or 4."
    done
    if [[ "$nvim_type" == "skip" ]]; then
      eval "$result_var=''"
      return
    fi
    local next
    next="$(bump_version "$current" "$nvim_type")"
    read -r -p "${label} version [${next}]: " nvim_override
    local final="${nvim_override:-$next}"
    is_semver "$final" || { echo "Invalid version: $final"; exit 1; }
    eval "$result_var='$final'"
  fi
}

prompt_nvim_version "nvim" "./packages/nvim/version.txt" VERSION_NVIM
prompt_nvim_version "nvim-completion" "./packages/nvim-completion/version.txt" VERSION_NVIM_COMP

# ── NPM auth ──────────────────────────────────────────────────────

TOKEN="${ZEROXZERO_NPM_TOKEN:-${NPM_TOKEN:-${NODE_AUTH_TOKEN:-}}}"
if [[ -z "$TOKEN" ]]; then
  read -r -s -p "Enter NPM token: " TOKEN
  echo
fi

[[ -n "$TOKEN" ]] || {
  echo "NPM token is required."
  exit 1
}

TMP_NPMRC="$(mktemp)"
cleanup() { rm -f "$TMP_NPMRC"; }
trap cleanup EXIT

{
  printf '%s:registry=https://registry.npmjs.org/\n' "$SCOPE"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN"
} > "$TMP_NPMRC"
chmod 600 "$TMP_NPMRC"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: skipping npm whoami auth check"
else
  npm_config_userconfig="$TMP_NPMRC" command npm whoami >/dev/null || {
    echo "npm auth failed. Check token scope/validity."
    exit 1
  }
fi

# ── Release plan ───────────────────────────────────────────────────

echo
echo "Release plan"
echo "  Repo:              $REPO"
echo "  Scope:             $SCOPE"
echo "  NPM tag:           $NPM_TAG"
echo "  Dry run:           $([[ "$DRY_RUN" -eq 1 ]] && echo yes || echo no)"
echo
echo "  0x0:               v$VERSION_0X0"
echo "  0x0-git:           v$VERSION_GIT"
echo "  nvim:              ${VERSION_NVIM:-skip}"
echo "  nvim-completion:   ${VERSION_NVIM_COMP:-skip}"
echo

read -r -p "Proceed with publish? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1

# ══════════════════════════════════════════════════════════════════
#  0x0 (server/TUI)
# ══════════════════════════════════════════════════════════════════

echo
echo "════ 0x0 v$VERSION_0X0 ════"

echo "1) Build artifacts"
run env ZEROXZERO_VERSION="$VERSION_0X0" bun ./packages/tui/script/build.ts

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "2) DRY RUN: skipping packaging and asset checks"
else
  echo "2) Package artifacts if missing"
  package_if_needed "0x0-darwin-arm64" "zip"
  package_if_needed "0x0-darwin-x64" "zip"
  package_if_needed "0x0-linux-arm64" "tgz"
  package_if_needed "0x0-linux-x64" "tgz"

  echo "3) Verify required assets"
  for f in \
    "./packages/tui/dist/0x0-darwin-arm64.zip" \
    "./packages/tui/dist/0x0-darwin-x64.zip" \
    "./packages/tui/dist/0x0-linux-arm64.tar.gz" \
    "./packages/tui/dist/0x0-linux-x64.tar.gz"
  do
    [[ -f "$f" ]] || { echo "Missing required asset: $f"; exit 1; }
  done
fi

echo "4) Ensure GitHub release exists"
if [[ "$DRY_RUN" -eq 1 ]]; then
  run gh release view "v$VERSION_0X0" --repo "$REPO"
  run gh release create "v$VERSION_0X0" --repo "$REPO" --title "v$VERSION_0X0" --notes "Release v$VERSION_0X0"
else
  gh release view "v$VERSION_0X0" --repo "$REPO" >/dev/null 2>&1 || \
    gh release create "v$VERSION_0X0" --repo "$REPO" --title "v$VERSION_0X0" --notes "Release v$VERSION_0X0"
fi

echo "5) Upload release assets"
run gh release upload "v$VERSION_0X0" ./packages/tui/dist/*.zip ./packages/tui/dist/*.tar.gz --repo "$REPO" --clobber

echo "6) Prepare npm package metadata"
prepare_npm_dist "$VERSION_0X0"

echo "7) Publish npm packages"
if [[ "$DRY_RUN" -eq 1 ]]; then
  run NPM_TOKEN="$TOKEN" bun ./packages/tui/script/publish-npm-manual.ts --scope "$SCOPE" --tag "$NPM_TAG" --version "$VERSION_0X0"
else
  NPM_TOKEN="$TOKEN" \
    bun ./packages/tui/script/publish-npm-manual.ts \
      --scope "$SCOPE" \
      --tag "$NPM_TAG" \
      --version "$VERSION_0X0"
fi

echo "8) Publish Homebrew tap (zeroxzero)"
run bun ./script/publish-tap.ts --version "$VERSION_0X0" --repo "$REPO"

echo "8b) Update source package.json versions"
set_pkg_version "./packages/server/package.json" "$VERSION_0X0"
set_pkg_version "./packages/tui/package.json" "$VERSION_0X0"

# ══════════════════════════════════════════════════════════════════
#  0x0-git
# ══════════════════════════════════════════════════════════════════

echo
echo "════ 0x0-git v$VERSION_GIT ════"

GIT_TAG="0x0-git-v${VERSION_GIT}"

echo "9) Build git package"
run env ZEROXZERO_VERSION="$VERSION_GIT" bun ./packages/git/script/build.ts

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "10) DRY RUN: skipping git packaging"
else
  echo "10) Package git artifacts"
  package_if_needed "0x0-git-darwin-arm64" "zip" "./packages/git"
  package_if_needed "0x0-git-darwin-x64" "zip" "./packages/git"
  package_if_needed "0x0-git-linux-arm64" "tgz" "./packages/git"
  package_if_needed "0x0-git-linux-x64" "tgz" "./packages/git"
fi

echo "11) Ensure GitHub release for git"
if [[ "$DRY_RUN" -eq 1 ]]; then
  run gh release view "$GIT_TAG" --repo "$REPO"
  run gh release create "$GIT_TAG" --repo "$REPO" --title "$GIT_TAG" --notes "Release $GIT_TAG"
else
  gh release view "$GIT_TAG" --repo "$REPO" >/dev/null 2>&1 || \
    gh release create "$GIT_TAG" --repo "$REPO" --title "$GIT_TAG" --notes "Release $GIT_TAG"
fi

echo "12) Upload git release assets"
run gh release upload "$GIT_TAG" ./packages/git/dist/*.zip ./packages/git/dist/*.tar.gz --repo "$REPO" --clobber

echo "13) Prepare git npm metadata"
prepare_git_npm_dist "$VERSION_GIT"

echo "14) Publish git npm packages"
if [[ "$DRY_RUN" -eq 1 ]]; then
  run NPM_TOKEN="$TOKEN" bun ./packages/git/script/publish-npm.ts --scope "$SCOPE" --tag "$NPM_TAG" --version "$VERSION_GIT"
else
  NPM_TOKEN="$TOKEN" \
    bun ./packages/git/script/publish-npm.ts \
      --scope "$SCOPE" \
      --tag "$NPM_TAG" \
      --version "$VERSION_GIT"
fi

echo "15) Publish Homebrew tap (zeroxzero-git)"
run bun ./script/publish-tap.ts --version "$VERSION_GIT" --repo "$REPO" --prefix 0x0-git --formula-name zeroxzero-git --tag "$GIT_TAG"

echo "15b) Update git source package.json version"
set_pkg_version "./packages/git/package.json" "$VERSION_GIT"

# ══════════════════════════════════════════════════════════════════
#  Neovim plugins
# ══════════════════════════════════════════════════════════════════

if [[ -n "$VERSION_NVIM" || -n "$VERSION_NVIM_COMP" ]]; then
  echo
  echo "════ Neovim plugins ════"
fi

if [[ -n "$VERSION_NVIM" ]]; then
  echo "16) Publish nvim plugin v$VERSION_NVIM"
  run bun ./script/publish-nvim.ts --plugin nvim --version "$VERSION_NVIM"
  echo "16b) Update nvim version.txt"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: set ./packages/nvim/version.txt to $VERSION_NVIM"
  else
    printf '%s\n' "$VERSION_NVIM" > ./packages/nvim/version.txt
    echo "Updated ./packages/nvim/version.txt to $VERSION_NVIM"
  fi
fi

if [[ -n "$VERSION_NVIM_COMP" ]]; then
  echo "17) Publish nvim-completion v$VERSION_NVIM_COMP"
  run bun ./script/publish-nvim.ts --plugin nvim-completion --version "$VERSION_NVIM_COMP"
  echo "17b) Update nvim-completion version.txt"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY RUN: set ./packages/nvim-completion/version.txt to $VERSION_NVIM_COMP"
  else
    printf '%s\n' "$VERSION_NVIM_COMP" > ./packages/nvim-completion/version.txt
    echo "Updated ./packages/nvim-completion/version.txt to $VERSION_NVIM_COMP"
  fi
fi

# ══════════════════════════════════════════════════════════════════
#  Commit version bumps
# ══════════════════════════════════════════════════════════════════
echo
echo "════ Commit version bumps ════"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: would commit version bumps to package.json and version.txt files"
else
  VERSION_FILES=(./packages/server/package.json ./packages/tui/package.json ./packages/git/package.json)
  [[ -n "$VERSION_NVIM" ]] && VERSION_FILES+=(./packages/nvim/version.txt)
  [[ -n "$VERSION_NVIM_COMP" ]] && VERSION_FILES+=(./packages/nvim-completion/version.txt)

  if ! git diff --quiet "${VERSION_FILES[@]}" 2>/dev/null; then
    git add "${VERSION_FILES[@]}"

    COMMIT_MSG="chore: bump versions — 0x0@${VERSION_0X0}, 0x0-git@${VERSION_GIT}"
    [[ -n "$VERSION_NVIM" ]] && COMMIT_MSG+=", nvim@${VERSION_NVIM}"
    [[ -n "$VERSION_NVIM_COMP" ]] && COMMIT_MSG+=", nvim-completion@${VERSION_NVIM_COMP}"

    git commit -m "$COMMIT_MSG"
    echo "Committed version bumps"
  else
    echo "No version changes to commit"
  fi
fi

# ══════════════════════════════════════════════════════════════════
#  Verify
# ══════════════════════════════════════════════════════════════════

echo
echo "════ Verify ════"
run curl -fL -I "https://github.com/$REPO/releases/download/v$VERSION_0X0/0x0-darwin-arm64.zip"
run command npm view "$SCOPE/0x0@$VERSION_0X0" version
run command npm view "$SCOPE/0x0-git@$VERSION_GIT" version

echo
echo "Done!"
echo "  0x0:             v$VERSION_0X0"
echo "  0x0-git:         v$VERSION_GIT"
echo "  nvim:            ${VERSION_NVIM:-skipped}"
echo "  nvim-completion: ${VERSION_NVIM_COMP:-skipped}"
echo
echo "Install:"
echo "  brew tap anonymous-dev-org/tap"
echo "  brew install 0x0"
echo "  brew install 0x0-git"
