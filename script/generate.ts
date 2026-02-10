#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun run --conditions=browser src/index.ts generate > ../sdk/openapi.json`.cwd("packages/0x0")

await $`./script/format.ts`
