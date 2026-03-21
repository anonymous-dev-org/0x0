import * as fs from "fs/promises"
import os from "os"
import path from "path"

function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

export async function tmpdir() {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "zeroxzero-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  const realpath = sanitizePath(await fs.realpath(dirpath))
  return {
    [Symbol.asyncDispose]: async () => {},
    path: realpath,
  }
}
