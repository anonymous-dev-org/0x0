import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

type Options = {
  os: string
  arch: string
  archive: boolean
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) {
    return undefined
  }
  return args[index + 1]
}

function parseOptions(): Options {
  const args = Bun.argv.slice(2)
  const os = readOption(args, "--os") ?? process.platform
  const arch = readOption(args, "--arch") ?? process.arch

  if (!["linux", "darwin"].includes(os)) {
    throw new Error(`Unsupported --os value: ${os}`)
  }
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported --arch value: ${arch}`)
  }

  return {
    os,
    arch,
    archive: args.includes("--archive"),
  }
}

async function run(command: string[], cwd?: string) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`)
  }
}

async function main() {
  const options = parseOptions()
  const packageName = `0x0-${options.os}-${options.arch}`
  const distDir = join(import.meta.dir, "..", "dist")
  const stageDir = join(distDir, packageName)
  const binaryPath = join(stageDir, "0x0")

  await mkdir(distDir, { recursive: true })
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })

  await run([
    "bun",
    "build",
    "./src/cli.ts",
    "--compile",
    "--target",
    `bun-${options.os}-${options.arch}`,
    "--outfile",
    binaryPath,
  ])

  if (!options.archive) {
    return
  }

  if (options.os === "darwin") {
    await rm(join(distDir, `${packageName}.zip`), { force: true })
    await run(["zip", "-qr", `../${packageName}.zip`, "."], stageDir)
  } else {
    await rm(join(distDir, `${packageName}.tar.gz`), { force: true })
    await run(["tar", "-czf", `../${packageName}.tar.gz`, "."], stageDir)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
