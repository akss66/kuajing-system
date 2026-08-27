import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { db } from "@/db/client";
import { seed } from "@/db/seed";

import { loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const seededCustomer = {
  email: "customer@tongzhouxing.local",
  password: "TongZhouXing-Customer-2026!",
};

test("customer home keeps the threeui accent decorative and responsive", async ({
  page,
}, testInfo) => {
  await resetE2EDatabaseToSeedState({
    context: "customer home threeui visual",
    database: db,
    reseed: seed,
  });
  await loginThroughUi(page, seededCustomer);
  await expect(page).toHaveURL(/\/portal$/);

  const accent = page.locator("[data-portal-brand-accent]");
  await expect(accent).toBeVisible();
  await expect(accent.getByText("CLIENT FLOW")).toBeVisible();
  await expect(
    accent.getByText("货盘、上传、订单与资金回到同一条工作线。"),
  ).toBeVisible();

  const scenes = accent.locator("[data-threeui-scene='portal']");
  await expect(scenes).toHaveCount(2);

  if (testInfo.project.name.includes("mobile")) {
    await expect(scenes.first()).toHaveAttribute("data-threeui-state", "fallback");
  } else {
    await expect(scenes.first()).toHaveAttribute("data-threeui-state", "enhanced");
    await expect(scenes.nth(1)).toHaveAttribute("data-threeui-state", "enhanced");
  }

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);

  await expect(page).toHaveScreenshot(`customer-home-threeui-${testInfo.project.name}.png`, {
    fullPage: true,
  });
});
