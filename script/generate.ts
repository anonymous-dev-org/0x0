#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun run src/index.ts generate > ../sdk/openapi.json`.cwd("packages/server")

await $`./script/format.ts`
