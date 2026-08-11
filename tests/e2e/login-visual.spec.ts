import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("login surface is accessible, responsive and uses the approved teal action color", async ({
  page,
}, testInfo) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "登录同舟行跨境" })).toBeVisible();
  const loginButton = page.getByRole("button", { name: "登录系统" });
  await expect(loginButton).toBeVisible();

  const buttonRgb = await loginButton.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return [];
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
  });
  expect(buttonRgb).toHaveLength(3);
  expect(buttonRgb[1]).toBeGreaterThan(buttonRgb[0] + 25);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await expect(page).toHaveScreenshot(`login-${testInfo.project.name}.png`, {
    fullPage: true,
  });
});
