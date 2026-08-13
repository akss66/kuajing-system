import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { count, eq } from "drizzle-orm";
import { createServer, type Server } from "node:http";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  jifengAuthorizationAttempts,
  jifengConnections,
} from "@/db/schema";
import { seed } from "@/db/seed";

import { createManagedUser, loginThroughUi } from "./support/managed-user";
import { resetE2EDatabaseToSeedState } from "./support/test-database";

const mockBaseUrl = process.env.JIFENG_BASE_URL ?? "";
const mockUrl = new URL(mockBaseUrl);
const happyToken = "e2e-happy-one-time-token-2026";
const invalidToken = "e2e-invalid-one-time-token-2026";
const consumedToken = "e2e-consumed-one-time-token-2026";
const ambiguousToken = "e2e-ambiguous-one-time-token-2026";
const authorizationCode = "e2e-authorization-code-private";
const accessToken = "e2e-access-token-private";
const refreshToken = "e2e-refresh-token-private";
const clientSecret = "e2e-client-secret-private";
const sensitiveValues = [
  happyToken,
  invalidToken,
  consumedToken,
  ambiguousToken,
  authorizationCode,
  accessToken,
  refreshToken,
  clientSecret,
];

type DiscoveryMode = "ambiguous" | "unique";
type CapturedActionRequest = {
  body: Buffer;
  headers: Record<string, string>;
  url: string;
};

let mockServer: Server;
let consumedTokens = new Set<string>();
let mockRequests: Array<{ method: string; path: string }> = [];
let unexpectedMockRequests: string[] = [];
const modeByAuthorizationCode = new Map<string, DiscoveryMode>();
const modeByAccessToken = new Map<string, DiscoveryMode>();

function jsonResponse(
  response: import("node:http").ServerResponse,
  payload: unknown,
) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function discoveryPayload(mode: DiscoveryMode) {
  const warehouses = [
    {
      code: "CA-TOR-01",
      country: "CA",
      isAuth: true,
      name: "Toronto read-only warehouse",
    },
  ];
  if (mode === "ambiguous") {
    warehouses.push({
      code: "CA-VAN-02",
      country: "CA",
      isAuth: true,
      name: "Vancouver read-only warehouse",
    });
  }
  return {
    logistics: {
      page: {
        heads: [],
        pageNo: 1,
        pageSize: 300,
        rows: [{ code: "CA-POST", id: 701, name: "Canada Post" }],
        totalPage: 1,
        totalSize: 1,
      },
    },
    warehouses,
  };
}

function startMockJifengServer() {
  mockServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", mockBaseUrl);
    const method = request.method ?? "GET";
    mockRequests.push({ method, path: url.pathname });

    if (method === "GET" && url.pathname === "/api/oauth/authorize") {
      const token = url.searchParams.get("token") ?? "";
      if (token === invalidToken || consumedTokens.has(token)) {
        jsonResponse(response, {
          code: 10001,
          data: null,
          requestId: "safe-oauth-rejection",
        });
        return;
      }
      const mode: DiscoveryMode = token === ambiguousToken ? "ambiguous" : "unique";
      consumedTokens.add(token);
      const code = `${authorizationCode}-${mode}`;
      modeByAuthorizationCode.set(code, mode);
      jsonResponse(response, { code: 0, data: code, requestId: "safe-oauth-success" });
      return;
    }

    if (method === "GET" && url.pathname === "/api/oauth/accessToken") {
      const code = url.searchParams.get("key") ?? "";
      const mode = modeByAuthorizationCode.get(code);
      if (!mode) {
        jsonResponse(response, { code: 10001, data: null, requestId: "safe-code-rejection" });
        return;
      }
      const issuedAccessToken = `${accessToken}-${mode}`;
      modeByAccessToken.set(issuedAccessToken, mode);
      jsonResponse(response, {
        code: 0,
        data: {
          accessToken: issuedAccessToken,
          expireIn: 3_600,
          refreshExpireIn: 86_400,
          refreshToken: `${refreshToken}-${mode}`,
          userId: `e2e-jifeng-user-${mode}`,
        },
        requestId: "safe-token-success",
      });
      return;
    }

    const issuedAccessToken = request.headers.accesstoken;
    const mode =
      typeof issuedAccessToken === "string"
        ? modeByAccessToken.get(issuedAccessToken)
        : undefined;
    if (method === "POST" && mode && url.pathname === "/api/warehouse/getList") {
      jsonResponse(response, { code: 0, data: discoveryPayload(mode).warehouses });
      return;
    }
    if (
      method === "POST" &&
      mode &&
      url.pathname === "/api/logistics/offline/page"
    ) {
      jsonResponse(response, { code: 0, data: discoveryPayload(mode).logistics });
      return;
    }
    if (method === "POST" && mode && url.pathname === "/api/order/get") {
      jsonResponse(response, { code: 50017, data: null, message: "not found" });
      return;
    }

    unexpectedMockRequests.push(`${method} ${url.pathname}`);
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 404, data: null }));
  });

  return new Promise<void>((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(Number(mockUrl.port), "127.0.0.1", () => resolve());
  });
}

function stopMockJifengServer() {
  if (!mockServer?.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    mockServer.close((error) => (error ? reject(error) : resolve()));
  });
}

async function resetJifengE2EBaseline() {
  await resetE2EDatabaseToSeedState({
    context: "Jifeng connection E2E reset",
    database: db,
    reseed: seed,
  });
  consumedTokens = new Set<string>();
  mockRequests = [];
  unexpectedMockRequests = [];
  modeByAuthorizationCode.clear();
  modeByAccessToken.clear();
}

async function createJifengSuperAdmin() {
  const { auth } = await import("@/modules/identity/auth");
  const password = "valid-jifeng-e2e-password-2026";
  const email = `jifeng-super-${crypto.randomUUID()}@e2e.tongzhouxing.local`;
  await auth.api.createUser({
    body: {
      email,
      name: "Jifeng E2E super administrator",
      password,
      role: "super_admin",
    },
  });
  await db.insert(adminUsers).values({
    displayName: "Jifeng E2E super administrator",
    loginIdentifier: email,
  });
  return { email, password };
}

function watchBrowserConsole(page: Page) {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  return messages;
}

async function expectNoSensitiveBrowserState(
  page: Page,
  actionResponses: string[],
  consoleMessages: string[],
) {
  const browserState = [
    await page.content(),
    page.url(),
    ...actionResponses,
    ...consoleMessages,
  ].join("\n");
  for (const value of sensitiveValues) {
    expect(browserState).not.toContain(value);
  }
  expect(
    consoleMessages.filter((message) => /^(error|warning):/.test(message)),
  ).toEqual([]);
}

async function submitAndReadAction(
  page: Page,
  submit: () => Promise<void>,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/admin/system/integrations"),
  );
  await submit();
  const response = await responsePromise;
  return response.text();
}

async function captureActionRequest(
  page: Page,
  submit: () => Promise<void>,
): Promise<CapturedActionRequest> {
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/admin/system/integrations"),
  );
  await submit();
  const request = await requestPromise;
  const body = request.postDataBuffer();
  if (!body) throw new Error("Server Action request body was unavailable");
  const headers = await request.allHeaders();
  for (const name of ["authorization", "content-length", "cookie", "host"]) {
    delete headers[name];
  }
  return { body, headers, url: request.url() };
}

async function replayActionAsCurrentSession(
  requestContext: APIRequestContext,
  action: CapturedActionRequest,
) {
  return requestContext.fetch(action.url, {
    data: action.body,
    headers: action.headers,
    method: "POST",
  });
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "打开账号菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function assertMockBoundary() {
  expect(unexpectedMockRequests).toEqual([]);
  expect(mockRequests.length).toBeGreaterThan(0);
  expect(
    mockRequests.every(({ path }) =>
      [
        "/api/oauth/authorize",
        "/api/oauth/accessToken",
        "/api/warehouse/getList",
        "/api/logistics/offline/page",
        "/api/order/get",
      ].includes(path),
    ),
  ).toBe(true);
  expect(mockRequests.some(({ path }) => /\/create|\/cancel/.test(path))).toBe(false);
}

async function screenshotForReview(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`),
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(mockUrl.hostname).toBe("127.0.0.1");
  expect(mockUrl.protocol).toBe("http:");
  await startMockJifengServer();
});

test.afterAll(async () => {
  await stopMockJifengServer();
});

test.beforeEach(async () => {
  await resetJifengE2EBaseline();
});

test("super admin authorizes, validates read-only access, and explicitly enables fulfillment", async ({
  page,
}, testInfo) => {
  const consoleMessages = watchBrowserConsole(page);
  const actionResponses: string[] = [];

  const superAdmin = await createJifengSuperAdmin();
  await loginThroughUi(page, superAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/system/integrations");
  await expect(page.getByRole("heading", { name: "外部集成" })).toBeVisible();
  await expect(page.getByLabel("一次性令牌")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("一次性令牌")).not.toHaveAttribute("value");

  await page.getByLabel("极风授权邮箱").fill("jifeng-owner@e2e.example.test");
  await page.getByLabel("一次性令牌").fill(happyToken);
  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("button", { name: "完成极风授权" }).click(),
    ),
  );
  await expect(page.getByText("已就绪，自动履约未启用")).toBeVisible();
  await expect(page.getByText("已关闭", { exact: true })).toBeVisible();

  await expect.poll(async () => (await db.select().from(jifengConnections))[0]).toMatchObject({
    lastDiagnosticAt: null,
    logisticsId: 701,
    status: "READY_DISABLED",
    warehouseCode: "CA-TOR-01",
  });

  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("button", { name: "运行只读诊断" }).click(),
    ),
  );
  await expect(page.getByText("只读连接诊断已通过。")).toBeVisible();
  await expect(page.getByText("已关闭", { exact: true })).toBeVisible();
  await expect.poll(async () => (await db.select().from(jifengConnections))[0]?.lastDiagnosticAt).not.toBeNull();

  await page.getByLabel("启用原因").fill("E2E consequence confirmation approved");
  await page.getByRole("button", { name: "启用自动履约" }).click();
  const dialog = page.getByRole("alertdialog", { name: "确认启用极风自动履约？" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "符合条件的已付款订单会自动发送到极风并进入真实仓库履约",
  );
  await expect(dialog).toHaveCSS("opacity", "1");
  await screenshotForReview(page, testInfo, "jifeng-enable-confirmation");

  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/admin/system/integrations"),
  );
  const capturedEnableAction = await captureActionRequest(page, () =>
    dialog.getByRole("button", { name: "确认启用自动履约" }).click(),
  );
  actionResponses.push(await (await responsePromise).text());
  await expect(page.getByText("自动履约已启用", { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await db.select().from(jifengConnections))[0]?.status).toBe("ENABLED");

  await signOut(page);
  const ordinaryAdmin = await createManagedUser({ role: "admin" });
  await loginThroughUi(page, ordinaryAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/system/integrations");
  await expect(page.getByLabel("极风连接权限说明")).toContainText("只读状态");
  await expect(page.getByRole("button", { name: /极风授权|发现资源|只读诊断|自动履约|断开/ })).toHaveCount(0);
  await expect(page.getByText("开发者 ID", { exact: true })).toHaveCount(0);

  const [{ value: auditCountBefore }] = await db
    .select({ value: count() })
    .from(auditLogs)
    .where(eq(auditLogs.action, "JIFENG_FULFILLMENT_ENABLED"));
  const forbiddenResponse = await replayActionAsCurrentSession(
    page.context().request,
    capturedEnableAction,
  );
  expect(forbiddenResponse.ok()).toBe(false);
  const [{ value: auditCountAfter }] = await db
    .select({ value: count() })
    .from(auditLogs)
    .where(eq(auditLogs.action, "JIFENG_FULFILLMENT_ENABLED"));
  expect(auditCountAfter).toBe(auditCountBefore);
  expect((await db.select().from(jifengConnections))[0]?.status).toBe("ENABLED");

  await assertMockBoundary();
  await expectNoSensitiveBrowserState(page, actionResponses, consoleMessages);
  expect(
    JSON.stringify({
      attempts: await db.select().from(jifengAuthorizationAttempts),
      audits: await db.select().from(auditLogs),
    }),
  ).not.toMatch(new RegExp(sensitiveValues.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
});

test("an invalid one-time token returns a safe retry path without disclosure", async ({
  page,
}) => {
  const consoleMessages = watchBrowserConsole(page);
  const actionResponses: string[] = [];
  const superAdmin = await createJifengSuperAdmin();
  await loginThroughUi(page, superAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/system/integrations");

  await page.getByLabel("极风授权邮箱").fill("jifeng-owner@e2e.example.test");
  await page.getByLabel("一次性令牌").fill(invalidToken);
  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("button", { name: "完成极风授权" }).click(),
    ),
  );
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "授权未完成，请获取新的一次性令牌后重试。" }),
  ).toBeVisible();
  await expect(page.getByLabel("一次性令牌")).toHaveValue("");
  await assertMockBoundary();
  await expectNoSensitiveBrowserState(page, actionResponses, consoleMessages);
});

test("a consumed one-time token cannot be reused and is never disclosed", async ({
  page,
}) => {
  const consoleMessages = watchBrowserConsole(page);
  const actionResponses: string[] = [];
  const superAdmin = await createJifengSuperAdmin();
  await loginThroughUi(page, superAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/system/integrations");

  await page.getByLabel("极风授权邮箱").fill("jifeng-owner@e2e.example.test");
  await page.getByLabel("一次性令牌").fill(consumedToken);
  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("button", { name: "完成极风授权" }).click(),
    ),
  );
  await expect(page.getByText("已就绪，自动履约未启用")).toBeVisible();

  await page.getByLabel("断开原因").fill("E2E consumed-token verification");
  await page.getByRole("button", { name: "断开极风连接" }).click();
  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("alertdialog").getByRole("button", { name: "确认断开连接" }).click(),
    ),
  );
  await expect(page.getByText("未连接", { exact: true }).first()).toBeVisible();

  await page.getByLabel("极风授权邮箱").fill("jifeng-owner@e2e.example.test");
  await page.getByLabel("一次性令牌").fill(consumedToken);
  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("button", { name: "完成极风授权" }).click(),
    ),
  );
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "授权未完成，请获取新的一次性令牌后重试。" }),
  ).toBeVisible();
  await expect(page.getByLabel("一次性令牌")).toHaveValue("");
  await assertMockBoundary();
  await expectNoSensitiveBrowserState(page, actionResponses, consoleMessages);
});

test("resource confirmation is labeled, accessible, and usable without 390px overflow", async ({
  page,
}, testInfo) => {
  const consoleMessages = watchBrowserConsole(page);
  const actionResponses: string[] = [];
  const superAdmin = await createJifengSuperAdmin();
  await loginThroughUi(page, superAdmin);
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("/admin/system/integrations");
  await page.getByLabel("极风授权邮箱").fill("jifeng-owner@e2e.example.test");
  await page.getByLabel("一次性令牌").fill(ambiguousToken);
  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("button", { name: "完成极风授权" }).click(),
    ),
  );
  await expect(page.getByText("待选择资源", { exact: true }).first()).toBeVisible();

  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("button", { name: "重新发现资源" }).click(),
    ),
  );
  const warehouse = page.getByLabel("选择极风仓库");
  const logistics = page.getByLabel("选择物流渠道");
  await expect(warehouse).toBeVisible();
  await expect(logistics).toBeVisible();
  await expect(warehouse).toHaveValue("");
  await expect(logistics).toHaveValue("");
  await warehouse.selectOption("CA-TOR-01");
  await logistics.selectOption("701");

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  const accessibility = await new AxeBuilder({ page }).analyze();
  const unexpectedAccessibilityViolations = accessibility.violations.filter(
    (violation) =>
      ["serious", "critical"].includes(violation.impact ?? "") &&
      !(
        violation.id === "color-contrast" &&
        violation.nodes.every((node) =>
          node.target.some((target) => String(target).includes('a[rel="noreferrer"]')),
        )
      ),
  );
  expect(
    unexpectedAccessibilityViolations,
  ).toEqual([]);
  await page.getByRole("button", { name: "确认履约资源" }).scrollIntoViewIfNeeded();
  await screenshotForReview(page, testInfo, "jifeng-resource-confirmation");

  actionResponses.push(
    await submitAndReadAction(page, () =>
      page.getByRole("button", { name: "确认履约资源" }).click(),
    ),
  );
  await expect(page.getByText("已就绪，自动履约未启用")).toBeVisible();
  await expect.poll(async () => (await db.select().from(jifengConnections))[0]).toMatchObject({
    logisticsId: 701,
    status: "READY_DISABLED",
    warehouseCode: "CA-TOR-01",
  });
  await assertMockBoundary();
  await expectNoSensitiveBrowserState(page, actionResponses, consoleMessages);
});
