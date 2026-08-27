import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { createManagedUser, loginThroughUi } from "./support/managed-user";

test("pre-hydration login never places credentials in the request URL", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    baseURL: String(testInfo.project.use.baseURL),
    javaScriptEnabled: false,
    viewport: testInfo.project.name.includes("mobile")
      ? { height: 844, width: 390 }
      : { height: 900, width: 1440 },
  });
  const page = await context.newPage();

  try {
    await page.goto("/login");
    const form = page.locator("form");
    const email = page.getByLabel("登录邮箱");
    const password = page.getByLabel("登录密码");
    const submit = page.getByRole("button", { name: "登录系统" });

    await expect(form).toHaveAttribute("method", "post");
    await expect(form).toHaveAttribute("action", "/login");
    await expect(email).toBeDisabled();
    await expect(password).toBeDisabled();
    await expect(submit).toBeDisabled();

    await page.route("**/login", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ body: "", status: 204 });
        return;
      }
      await route.continue();
    });
    const nativeRequest = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname === "/login",
    );
    await page.locator("form").evaluate((element) => {
      const formElement = element as HTMLFormElement;
      const emailInput = formElement.elements.namedItem("email") as HTMLInputElement;
      const passwordInput = formElement.elements.namedItem("password") as HTMLInputElement;
      const submitButton = formElement.querySelector<HTMLButtonElement>('button[type="submit"]');
      emailInput.disabled = false;
      passwordInput.disabled = false;
      if (submitButton) submitButton.disabled = false;
      emailInput.value = "pre-hydration@example.com";
      passwordInput.value = "never-appear-in-a-url";
      formElement.requestSubmit();
    });

    const requestUrl = (await nativeRequest).url();
    expect(requestUrl).toBe(`${String(testInfo.project.use.baseURL)}/login`);
    expect(requestUrl).not.toContain("pre-hydration");
    expect(requestUrl).not.toContain("never-appear-in-a-url");
  } finally {
    await context.close();
  }
});

test("hydrated login still authenticates through Better Auth", async ({ page }) => {
  const administrator = await createManagedUser({ role: "super_admin" });

  await loginThroughUi(page, administrator);

  await expect(page).toHaveURL(/\/admin$/);
});

test("login surface is accessible, responsive and uses the approved teal action color", async ({
  page,
}, testInfo) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录同舟行跨境" })).toHaveCount(0);
  await expect(page.getByText("AI+Agent+跨境")).toBeVisible();
  const loginScene = page.locator("[data-threeui-scene='login']");
  await expect(loginScene).toHaveAttribute(
    "data-threeui-state",
    testInfo.project.name.includes("mobile") ? "fallback" : "enhanced",
  );
  const loginPanel = page.locator("[data-login-panel]");
  await expect(loginPanel).toBeVisible();
  await expect(page.getByText("Designed & Developed by ZZY")).toBeVisible();
  const heroHeading = page.getByRole("heading", { name: /加拿大本地货盘.*一站式经营更简单/ });
  const heroDescription = page.getByText(
    "一键上传订单、跟进付款与发货状态，让每一次发货都清晰、可追踪、可恢复。",
  );
  if (testInfo.project.name.includes("mobile")) {
    await expect(heroHeading).toBeHidden();
    await expect(heroDescription).toBeHidden();
    await expect(page.locator("[data-login-shell]")).toHaveCSS("justify-content", "center");
  } else {
    await expect(heroHeading).toBeVisible();
    await expect(heroDescription).toBeVisible();
    const heroRgb = await page.locator("[data-login-hero]").evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) return [];
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
    });
    expect(heroRgb).toHaveLength(3);
    expect(Math.min(...heroRgb)).toBeGreaterThan(38);
    expect(Math.max(...heroRgb)).toBeLessThan(86);
    expect(Math.max(...heroRgb) - Math.min(...heroRgb)).toBeLessThan(10);
  }
  await expect(loginPanel).toHaveCSS("border-top-width", "0px");
  await expect(loginPanel).toHaveCSS("border-radius", "0px");
  await expect(loginPanel).toHaveCSS("box-shadow", "none");
  await expect(page.getByLabel("登录邮箱")).not.toHaveAttribute("placeholder");
  await expect(page.getByLabel("登录密码")).not.toHaveAttribute("placeholder");
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
