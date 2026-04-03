import { describe, it, expect, afterEach } from "bun:test"
import { PidFile } from "@/daemon/pid"

describe("PidFile", () => {
  afterEach(async () => {
    await PidFile.remove()
  })

  it("write() and read() round-trips pid info", async () => {
    await PidFile.write({ pid: 12345, port: 4096 })
    const info = await PidFile.read()
    expect(info).toEqual({ pid: 12345, port: 4096 })
  })

  it("read() returns undefined when no file exists", async () => {
    const info = await PidFile.read()
    expect(info).toBeUndefined()
  })

  it("remove() deletes the pid file", async () => {
    await PidFile.write({ pid: 99999, port: 8080 })
    await PidFile.remove()
    const info = await PidFile.read()
    expect(info).toBeUndefined()
  })

  it("remove() is safe to call when no file exists", async () => {
    // Should not throw
    await PidFile.remove()
  })

  it("isRunning() returns true for current process", () => {
    expect(PidFile.isRunning(process.pid)).toBe(true)
  })

  it("isRunning() returns false for non-existent pid", () => {
    // PID 99999999 should not exist
    expect(PidFile.isRunning(99999999)).toBe(false)
  })

  it("write() overwrites existing pid file", async () => {
    await PidFile.write({ pid: 111, port: 1111 })
    await PidFile.write({ pid: 222, port: 2222 })
    const info = await PidFile.read()
    expect(info).toEqual({ pid: 222, port: 2222 })
  })
})
