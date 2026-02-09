import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test("smoke @ quick params switches agent", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("@ag")

  const property = page.getByRole("button", { name: /@agent:/i }).first()
  await expect(property).toBeVisible()
  await property.hover()

  await page.keyboard.press("Tab")
  await expect(page.locator(promptSelector)).toContainText("@agent:")

  await page.keyboard.type("plan")

  const value = page.getByRole("button", { name: /@agent:plan/i }).first()
  await expect(value).toBeVisible()
  await value.hover()

  await page.keyboard.press("Tab")

  await expect(page.locator(promptSelector)).not.toContainText("@agent:")
  await expect(page.locator(`${promptSelector} [data-type="agent"]`)).toHaveCount(0)
  await expect(page.locator('[data-slot="prompt-quick-agent"]')).toHaveText(/plan/i)
})
