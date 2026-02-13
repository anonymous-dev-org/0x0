#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-anonymous-dev-org/0x0}"
SCOPE="${SCOPE:-@anonymous-dev}"
NPM_TAG="${NPM_TAG:-latest}"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: ./script/release-local.sh [--dry-run]

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
  local src="./packages/0x0/dist/${name}/bin"
  local out="./packages/0x0/dist/${name}"

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

  run rm -rf ./packages/0x0/dist/0x0
  run mkdir -p ./packages/0x0/dist/0x0
  run cp -r ./packages/0x0/bin ./packages/0x0/dist/0x0/bin
  run cp ./packages/0x0/script/postinstall.mjs ./packages/0x0/dist/0x0/postinstall.mjs
  run cp ./LICENSE ./packages/0x0/dist/0x0/LICENSE

  SCOPE="$SCOPE" VERSION="$version" bun -e '
    const scope = process.env.SCOPE
    if (!scope) throw new Error("Missing SCOPE")

    const pkg = await Bun.file("./packages/0x0/package.json").json()
    const dist = "./packages/0x0/dist"
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
    if (!version) throw new Error("No built binaries found in ./packages/0x0/dist")

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

need_cmd git
need_cmd bun
need_cmd gh
need_cmd npm
need_cmd curl
need_cmd zip
need_cmd tar

[[ -f "./packages/0x0/script/build.ts" ]] || {
  echo "Run this from repo root."
  exit 1
}

latest_tag="$(pick_latest_tag)"
if [[ -z "${latest_tag}" ]]; then
  echo "No semver tags or releases found. Start from 0.0.0."
  latest_tag="v0.0.0"
fi
latest_version="$(semver_from_tag "$latest_tag")"

echo "Latest tag: ${latest_tag}"
echo "Select release type:"
select release_type in major minor patch; do
  [[ -n "${release_type:-}" ]] && break
  echo "Choose 1, 2, or 3."
done

next_version="$(bump_version "$latest_version" "$release_type")"
echo "Proposed version: ${next_version}"

read -r -p "Override version? (leave empty to keep ${next_version}): " override
VERSION="${override:-$next_version}"

is_semver "$VERSION" || {
  echo "Invalid version: $VERSION"
  exit 1
}

if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  echo "Tag v${VERSION} already exists."
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login"
  exit 1
fi

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

printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > "$TMP_NPMRC"
chmod 600 "$TMP_NPMRC"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: skipping npm whoami auth check"
else
  npm whoami --userconfig "$TMP_NPMRC" >/dev/null || {
    echo "npm auth failed. Check token scope/validity."
    exit 1
  }
fi

echo
echo "Release plan"
echo "  Repo:    $REPO"
echo "  Scope:   $SCOPE"
echo "  Tag:     v$VERSION"
echo "  NPM tag: $NPM_TAG"
echo "  Dry run: $([[ "$DRY_RUN" -eq 1 ]] && echo yes || echo no)"
echo

read -r -p "Proceed with publish? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1

echo "1) Build artifacts"
run bun ./packages/0x0/script/build.ts

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
    "./packages/0x0/dist/0x0-darwin-arm64.zip" \
    "./packages/0x0/dist/0x0-darwin-x64.zip" \
    "./packages/0x0/dist/0x0-linux-arm64.tar.gz" \
    "./packages/0x0/dist/0x0-linux-x64.tar.gz"
  do
    [[ -f "$f" ]] || { echo "Missing required asset: $f"; exit 1; }
  done
fi

echo "4) Ensure GitHub release exists"
if [[ "$DRY_RUN" -eq 1 ]]; then
  run gh release view "v$VERSION" --repo "$REPO"
  run gh release create "v$VERSION" --repo "$REPO" --title "v$VERSION" --notes "Release v$VERSION"
else
  gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1 || \
    gh release create "v$VERSION" --repo "$REPO" --title "v$VERSION" --notes "Release v$VERSION"
fi

echo "5) Upload release assets"
run gh release upload "v$VERSION" ./packages/0x0/dist/*.zip ./packages/0x0/dist/*.tar.gz --repo "$REPO" --clobber

echo "6) Prepare npm package metadata"
prepare_npm_dist "$VERSION"

echo "7) Publish npm packages"
if [[ "$DRY_RUN" -eq 1 ]]; then
  run env -u ZEROXZERO_NPM_TOKEN -u NPM_TOKEN -u NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG="$TMP_NPMRC" bun ./packages/0x0/script/publish-npm-manual.ts --scope "$SCOPE" --tag "$NPM_TAG" --version "$VERSION"
else
  env \
    -u ZEROXZERO_NPM_TOKEN \
    -u NPM_TOKEN \
    -u NODE_AUTH_TOKEN \
    NPM_CONFIG_USERCONFIG="$TMP_NPMRC" \
    bun ./packages/0x0/script/publish-npm-manual.ts \
      --scope "$SCOPE" \
      --tag "$NPM_TAG" \
      --version "$VERSION"
fi

echo "8) Publish Homebrew tap"
run bun ./script/publish-tap.ts --version "$VERSION" --repo "$REPO"

echo "9) Verify"
run curl -fL -I "https://github.com/$REPO/releases/download/v$VERSION/0x0-darwin-arm64.zip"
run npm view "$SCOPE/0x0@$VERSION" version

echo "Done: v$VERSION published."
