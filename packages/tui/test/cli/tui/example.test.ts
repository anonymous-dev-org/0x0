import { describe, expect, test } from "bun:test"

describe("example", () => {
  test("adds two numbers", () => {
    expect(1 + 1).toBe(2)
  })

  test("string concatenation", () => {
    expect("hello" + " " + "world").toBe("hello world")
  })

  test("array includes element", () => {
    const items = ["apple", "banana", "cherry"]
    expect(items.includes("banana")).toBe(true)
    expect(items.includes("grape")).toBe(false)
  })
})
