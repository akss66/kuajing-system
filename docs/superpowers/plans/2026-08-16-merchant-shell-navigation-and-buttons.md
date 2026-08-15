# Merchant Shell Navigation and Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cheap-looking collapsible merchant navigation and generic raised buttons with a static, clearly layered sidebar, a continuous topbar/sidebar seam, and one professional action hierarchy shared by admin and customer surfaces.

**Architecture:** Keep the existing route arrays, role filtering, `MerchantShellFrame`, Radix Sheet, and local shadcn primitives. `NavigationSection` becomes a stateless renderer built from `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupContent`, `SidebarMenu`, and `SidebarMenuItem`; the overview link is an unlabeled first group, while all remaining labels are non-interactive headings. Shell geometry continues to use `--merchant-sidebar-width`, and button appearance remains centralized in `buttonVariants` rather than being restyled page by page.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4, shadcn/ui local primitives, Radix UI Sheet/AlertDialog, Lucide icons, Vitest + Testing Library, Playwright, axe-core.

## Global Constraints

- Follow the approved design specification at `docs/superpowers/specs/2026-08-16-merchant-shell-navigation-and-buttons-design.md`.
- Do not change menu names, routes, role permissions, business workflows, authentication, or audit behavior.
- Do not add a runtime UI dependency; use the existing `src/components/ui/sidebar.tsx`, `src/components/ui/button.tsx`, Radix, Lucide, and project tokens.
- Desktop navigation remains fixed at `--merchant-sidebar-width: 14rem` (224px); all groups are always expanded and no group or whole-sidebar collapse state is introduced.
- Mobile navigation remains a Sheet; labels are static, every link is directly visible, and navigation links/key actions are at least 44px high.
- Current navigation must keep `aria-current="page"` and add a non-color-only 2px active rail.
- Primary buttons use the existing deep teal token family, no shadow, no pressed translation, 8px radius, 40px desktop height, and at least 44px for mobile key actions.
- Destructive page actions are outline/soft-red; only the final irreversible AlertDialog action may use a solid red fill.
- Desktop acceptance viewports are 1440×900 and 1920×1080. Mobile acceptance viewports are 430×900, 390×844, and 360×800.
- Browser acceptance requires no horizontal overflow, no hydration/page/console errors, axe serious/critical findings equal to zero, and manually reviewed unmasked snapshots.
- Read the relevant local Next.js 16 guides under `node_modules/next/dist/docs/` before changing App Router shell code.
- Preserve all unrelated dirty or untracked files; stage only the files named by the current task.

---

## File and Interface Map

- `src/components/layout/navigation-section.tsx`: stateless shared navigation group renderer; owns path matching, static group headings, active rail, and mobile `SheetClose` wrapping.
- `src/components/layout/admin-shell.tsx`: admin route/role data only; supplies one unlabeled overview group followed by four labeled groups.
- `src/components/layout/customer-shell.tsx`: customer route data only; supplies one unlabeled overview group followed by two labeled groups.
- `src/components/layout/merchant-shell-frame.tsx`: owns header/sidebar/content geometry and border ownership.
- `src/app/globals.css`: owns merchant shell width and color tokens shared by layout and buttons.
- `src/components/ui/button.tsx`: owns visual variants and sizes for every shared button.
- `src/components/forms/action-form.tsx`: owns pending-state semantics for ordinary server-action submission.
- `src/components/forms/confirmed-action-form.tsx`: owns soft destructive trigger and solid destructive confirmation.
- `src/components/customers/create-customer-drawer.tsx`: representative page-level primary CTA; only layout/size may be specified locally.
- `tests/unit/ui/merchant-shell.test.tsx`: shell navigation semantics, permission filtering, active state, and no-persistence contract.
- `tests/unit/ui/button.test.tsx`: shared button variant, size, disabled, focus, and motion contract.
- `tests/unit/customers/customer-management-pages.test.tsx`: representative primary CTA and drawer regression.
- `tests/e2e/ui-v2-shell.spec.ts`: exact desktop/mobile shell geometry, static headings, focus return, accessibility, and seam checks.
- `tests/e2e/ui-v2-responsive.spec.ts`: both-audience route matrix, mobile 44px targets, overflow, and error collection.
- `tests/e2e/merchant-center-visual.spec.ts` and its snapshot directory: unmasked visual approval across the existing merchant routes.

---

### Task 1: Replace Collapsible Navigation with Static shadcn Groups

**Files:**
- Modify: `src/components/layout/navigation-section.tsx`
- Modify: `src/components/layout/admin-shell.tsx`
- Modify: `src/components/layout/customer-shell.tsx`
- Modify: `tests/unit/ui/merchant-shell.test.tsx`

**Interfaces:**
- Consumes: existing `NavigationItem`, `usePathname()`, `useSearchParams()`, `SheetClose`, and shadcn `SidebarGroup`/`SidebarGroupLabel`/`SidebarGroupContent`/`SidebarMenu`/`SidebarMenuItem`.
- Produces: `NavigationSectionProps = { id: string; label?: string; items: NavigationItem[]; activePath: string; mobile?: boolean }` and a renderer with no local state, no `defaultOpen`, no `aria-expanded`, and no localStorage key.

- [ ] **Step 1: Rewrite the shell unit expectations as a RED contract**

Replace the collapse/persistence tests in `tests/unit/ui/merchant-shell.test.tsx` with assertions that labels are headings, all links are immediately present, no group label is a button, and render does not write navigation state:

```tsx
it("renders static navigation labels with every route visible and no collapse state", () => {
  render(
    <AdminShell identity={adminIdentity} principalKind="SUPER_ADMIN">
      <div>内容</div>
    </AdminShell>,
  );

  const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
  for (const label of ["客户与货品", "订单履约", "资金与数据", "系统管理"]) {
    expect(within(navigation).getByRole("heading", { level: 2, name: label })).toBeVisible();
    expect(within(navigation).queryByRole("button", { name: label })).not.toBeInTheDocument();
  }
  expect(within(navigation).queryByText("工作台")).not.toBeInTheDocument();
  expect(within(navigation).getByRole("link", { name: "运营总览" })).toBeVisible();
  expect(within(navigation).getByRole("link", { name: "系统健康" })).toBeVisible();
  expect(navigation.querySelector("[aria-expanded]")).toBeNull();
  expect(window.localStorage.length).toBe(0);
});

it("marks the current route with aria-current and a non-color active rail", () => {
  navigationState.pathname = "/admin/system/health";
  render(
    <AdminShell identity={adminIdentity} principalKind="SUPER_ADMIN">
      <div>内容</div>
    </AdminShell>,
  );

  const navigation = screen.getAllByRole("navigation", { name: "管理员主导航" })[0];
  const current = within(navigation).getByRole("link", { name: "系统健康" });
  expect(current).toHaveAttribute("aria-current", "page");
  expect(current).toHaveClass("before:w-0.5", "before:bg-[var(--merchant-nav-active-foreground)]");
});
```

Keep the existing ordinary-admin and customer assertions, but remove every click on a group label and assert the links directly.

- [ ] **Step 2: Run the focused test and verify the old implementation fails**

Run:

```powershell
npm.cmd test -- tests/unit/ui/merchant-shell.test.tsx
```

Expected: FAIL because group labels are still buttons, `工作台` still renders, and navigation state is stored.

- [ ] **Step 3: Implement the stateless navigation group**

Replace `NavigationSection` state, events, `ChevronDown`, and localStorage logic with this structure:

```tsx
export type NavigationSectionProps = {
  id: string;
  label?: string;
  items: NavigationItem[];
  activePath: string;
  mobile?: boolean;
};

export function NavigationSection({
  activePath,
  id,
  items,
  label,
  mobile = false,
}: NavigationSectionProps) {
  const currentHref = useMemo(() => activeHref(items, activePath), [activePath, items]);
  const containsCurrentPage = currentHref !== undefined;

  return (
    <SidebarGroup
      className={cn("p-0", label ? "mt-5 first:mt-0" : "")}
      data-current-group={containsCurrentPage}
      data-navigation-section={id}
    >
      {label ? (
        <SidebarGroupLabel asChild className="h-auto rounded-none px-3 pb-2 pt-0 text-xs font-medium tracking-normal text-muted-foreground">
          <h2>{label}</h2>
        </SidebarGroupLabel>
      ) : null}
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {items.map((item) => {
            const active = item.href === currentHref;
            const link = (
              <Link
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors before:absolute before:left-0 before:top-1/2 before:h-6 before:-translate-y-1/2 before:rounded-full",
                  mobile ? "min-h-11" : "min-h-10",
                  active
                    ? "bg-[var(--merchant-nav-active)] text-[var(--merchant-nav-active-foreground)] before:w-0.5 before:bg-[var(--merchant-nav-active-foreground)]"
                    : "text-muted-foreground before:w-0 hover:bg-[var(--merchant-nav-hover)] hover:text-foreground",
                )}
                href={item.href}
              >
                <item.icon aria-hidden="true" className="size-[18px] shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </Link>
            );

            return (
              <SidebarMenuItem key={item.href}>
                {mobile ? <SheetClose asChild>{link}</SheetClose> : link}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
```

Import the five shadcn primitives from `@/components/ui/sidebar`; do not use `SidebarMenuButton`, because its tooltip/collapse context is intentionally outside this fixed-width design.

- [ ] **Step 4: Flatten the overview groups in both audiences**

Change the admin group type and first group to:

```tsx
type AdminNavigationGroup = {
  id: string;
  label?: string;
  items: NavigationItem[];
};

{
  id: "admin-overview",
  items: [{ href: "/admin", icon: LayoutDashboard, label: "运营总览", exact: true }],
},
```

Remove every `defaultOpen` property and prop. Apply the same shape to the customer first group:

```tsx
{
  id: "customer-overview",
  items: [{ href: "/portal", icon: LayoutDashboard, label: "客户首页", exact: true }],
},
```

Keep every subsequent label, item, href, icon, and role-filter expression unchanged.

- [ ] **Step 5: Run focused unit, type, lint, and diff checks**

Run:

```powershell
npm.cmd test -- tests/unit/ui/merchant-shell.test.tsx
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Expected: shell unit PASS; typecheck/lint/diff-check exit 0.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/components/layout/navigation-section.tsx src/components/layout/admin-shell.tsx src/components/layout/customer-shell.tsx tests/unit/ui/merchant-shell.test.tsx
git diff --cached --check
git commit -m "refactor: simplify merchant navigation hierarchy"
```

---

### Task 2: Remove the Topbar/Sidebar White Seam

**Files:**
- Modify: `src/components/layout/merchant-shell-frame.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/unit/ui/merchant-shell.test.tsx`
- Modify: `tests/e2e/ui-v2-shell.spec.ts`

**Interfaces:**
- Consumes: `--merchant-header-height`, `--merchant-sidebar-width`, `MerchantBrand`, and the existing `data-merchant-*` hooks.
- Produces: one continuous topbar bottom border, zero brand right border, one sidebar right border below the topbar, and geometry derived exclusively from `--merchant-sidebar-width`.

- [ ] **Step 1: Add RED unit assertions for border ownership**

Add to the first shell unit test:

```tsx
const brand = document.querySelector<HTMLElement>("[data-merchant-brand]");
const sidebar = document.querySelector<HTMLElement>("[data-merchant-sidebar]");
const topbar = screen.getByRole("banner");

expect(brand).not.toHaveClass("border-r", "border-white/12");
expect(sidebar).toHaveClass("border-r", "border-border");
expect(topbar).toHaveClass("border-b");
expect(brand).toHaveClass("w-[var(--merchant-sidebar-width)]");
```

- [ ] **Step 2: Run the focused unit test and verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/ui/merchant-shell.test.tsx
```

Expected: FAIL because the brand currently owns `border-r border-white/12`.

- [ ] **Step 3: Assign each border to exactly one shell layer**

Change the header/brand classes in `merchant-shell-frame.tsx` to:

```tsx
<header
  className="fixed inset-x-0 top-0 z-40 flex h-[var(--merchant-header-height)] border-b border-[color-mix(in_oklch,var(--merchant-topbar),white_14%)] bg-[var(--merchant-topbar)] text-[var(--merchant-topbar-foreground)]"
  data-merchant-topbar={audience}
>
  <MerchantBrand
    audience={audience}
    className="hidden w-[var(--merchant-sidebar-width)] lg:flex"
  />
```

Keep the sidebar boundary exactly once:

```tsx
className="fixed bottom-0 left-0 top-[var(--merchant-header-height)] z-30 hidden w-[var(--merchant-sidebar-width)] overflow-y-auto border-r border-border bg-[var(--merchant-sidebar)] lg:block"
```

Keep `--merchant-sidebar-width: 14rem` in `globals.css`, and do not add a second numeric width token.

- [ ] **Step 4: Add computed-style and geometry assertions to the shell E2E**

Inside the desktop viewport branch of `tests/e2e/ui-v2-shell.spec.ts`, add:

```ts
await expect(page.locator("[data-merchant-brand]")).toHaveCSS("border-right-width", "0px");
await expect(page.locator("[data-merchant-sidebar]")).toHaveCSS("border-right-width", "1px");

const brandRight = brand!.x + brand!.width;
const sidebarRight = sidebar!.x + sidebar!.width;
expect(brandRight).toBe(224);
expect(sidebarRight).toBe(224);
```

Retain the existing 56px header and 224px sidebar geometry assertions.

- [ ] **Step 5: Run focused shell verification**

Run:

```powershell
npm.cmd test -- tests/unit/ui/merchant-shell.test.tsx
npm.cmd run test:e2e -- tests/e2e/ui-v2-shell.spec.ts --workers 1
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Expected: unit PASS; shell E2E PASS for admin/customer and all five viewport sizes; static group expectation failures, if any, must be fixed in the test to match Task 1's approved contract rather than reintroducing buttons.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/components/layout/merchant-shell-frame.tsx src/app/globals.css tests/unit/ui/merchant-shell.test.tsx tests/e2e/ui-v2-shell.spec.ts
git diff --cached --check
git commit -m "fix: unify merchant shell boundaries"
```

---

### Task 3: Establish the Shared Button Hierarchy

**Files:**
- Create: `tests/unit/ui/button.test.tsx`
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/forms/action-form.tsx`
- Modify: `src/components/forms/confirmed-action-form.tsx`
- Modify: `src/components/customers/create-customer-drawer.tsx`
- Modify: `tests/unit/customers/customer-management-pages.test.tsx`

**Interfaces:**
- Consumes: `buttonVariants`, `Button`, `ActionForm`, `ConfirmedActionForm`, existing `--primary`, `--primary-hover`, `--destructive`, and `--radius-control` tokens.
- Produces: variants `default`, `outline`, `secondary`, `ghost`, `destructive`, `destructiveSolid`, and `link`; default 40px height; pending buttons expose `aria-busy`; representative “新建客户” CTA uses Lucide Plus and shared styling only.

- [ ] **Step 1: Create RED tests for primary, secondary, destructive, disabled, and motion behavior**

Create `tests/unit/ui/button.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button, buttonVariants } from "@/components/ui/button";

describe("Button", () => {
  it("uses a stable shadowless primary action with a 40px default height", () => {
    render(<Button>新建客户</Button>);
    const button = screen.getByRole("button", { name: "新建客户" });
    expect(button).toHaveClass("h-10", "bg-primary", "hover:bg-primary-hover");
    expect(button.className).not.toMatch(/shadow|translate-y/);
  });

  it("keeps secondary and destructive page actions quiet", () => {
    expect(buttonVariants({ variant: "outline" })).toContain("border-border");
    expect(buttonVariants({ variant: "destructive" })).toContain("border-destructive/25");
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-background");
    expect(buttonVariants({ variant: "destructiveSolid" })).toContain("bg-destructive");
  });

  it("does not submit again while disabled", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>正在保存</Button>);
    fireEvent.click(screen.getByRole("button", { name: "正在保存" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the button test and verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/ui/button.test.tsx
```

Expected: FAIL because default is `h-9`, base styles include `translate-y-px`, primary includes a shadow, and `destructiveSolid` does not exist.

- [ ] **Step 3: Replace the shared Button visual contract**

Update the `cva` base and variants to:

```tsx
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-[var(--duration-fast)] outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/22 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/18 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        outline: "border-border bg-background text-foreground hover:bg-[var(--merchant-nav-hover)]",
        secondary: "border-border/70 bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        ghost: "bg-transparent text-foreground hover:bg-[var(--merchant-nav-hover)]",
        destructive: "border-destructive/25 bg-background text-destructive hover:bg-destructive/8 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        destructiveSolid: "border-destructive bg-destructive text-white hover:bg-[color-mix(in_oklch,var(--destructive),black_14%)] focus-visible:ring-destructive/25",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 gap-2 px-3.5",
        xs: "h-7 gap-1 rounded-[var(--radius-control)] px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-[var(--radius-control)] px-2.5 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-4",
        icon: "size-10",
        "icon-xs": "size-7 rounded-[var(--radius-control)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-[var(--radius-control)]",
        "icon-lg": "size-11 rounded-[var(--radius-control)]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
```

Retain the existing `has-data-[icon=...]` padding adjustments if existing call sites use them, but do not restore shadow or transform tokens.

- [ ] **Step 4: Standardize pending and destructive confirmation semantics**

In `ActionForm`, add `aria-busy={pending}` and `data-loading={pending || undefined}` to the submit `Button` while preserving `disabled={pending || submitDisabled}` and the existing `LoaderCircle`.

In `ConfirmedActionForm`:

```tsx
<Button
  aria-busy={pending}
  className="min-h-11 px-4"
  data-loading={pending || undefined}
  disabled={disabled || pending}
  type="button"
  variant={variant}
>
```

Replace the final AlertDialog action's hard-coded `!bg-[rgb(...)]` classes with:

```tsx
<AlertDialogAction
  className="min-h-11"
  form={formId}
  type="submit"
  variant={variant === "destructive" ? "destructiveSolid" : variant}
>
  {confirmLabel}
</AlertDialogAction>
```

- [ ] **Step 5: Make “新建客户” a representative responsive primary CTA**

In `create-customer-drawer.tsx`, keep the Lucide `Plus` and change only the trigger's responsive size class:

```tsx
<Button className="h-10 px-4 max-sm:min-h-11" variant={first ? "outline" : "default"}>
  <Plus aria-hidden="true" />
  {first ? "新建第一位客户" : "新建客户"}
</Button>
```

Extend `customer-management-pages.test.tsx`:

```tsx
const createCustomer = screen.getByRole("button", { name: "新建客户" });
expect(createCustomer).toHaveAttribute("data-variant", "default");
expect(createCustomer.querySelector("svg")).not.toBeNull();
expect(createCustomer.className).not.toMatch(/shadow|translate-y/);
```

- [ ] **Step 6: Run focused button and representative business tests**

Run:

```powershell
npm.cmd test -- tests/unit/ui/button.test.tsx tests/unit/customers/customer-management-pages.test.tsx tests/unit/accounts/account-management.test.tsx
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Expected: all focused units PASS; types/lint/diff-check exit 0.

- [ ] **Step 7: Commit Task 3**

```powershell
git add src/components/ui/button.tsx src/components/forms/action-form.tsx src/components/forms/confirmed-action-form.tsx src/components/customers/create-customer-drawer.tsx tests/unit/ui/button.test.tsx tests/unit/customers/customer-management-pages.test.tsx
git diff --cached --check
git commit -m "refactor: establish merchant action hierarchy"
```

---

### Task 4: Prove Both Audiences Across Responsive and Visual Gates

**Files:**
- Modify: `tests/e2e/ui-v2-shell.spec.ts`
- Modify: `tests/e2e/ui-v2-responsive.spec.ts`
- Modify when intentional visual diffs are approved: `tests/e2e/merchant-center-visual.spec.ts-snapshots/*.png`
- Modify when intentional visual diffs are approved: any other already-tracked `*-snapshots/*.png` changed by the two named shell/catalog/account visual suites
- Create: `.superpowers/sdd/2026-08-16-merchant-shell-navigation-buttons/task-4-report.md` (ignored evidence file; do not stage if ignored)

**Interfaces:**
- Consumes: Task 1 static group headings, Task 2 seam ownership, Task 3 button variants, existing Playwright auth/reset helpers, and existing approved viewport arrays.
- Produces: browser evidence for admin/customer navigation, 44px mobile targets, no seam, no overflow/errors, zero serious/critical axe findings, and manually approved unmasked baselines.

- [ ] **Step 1: Update E2E navigation fixtures to the approved hierarchy**

Use these exact group arrays in both shell/responsive specs:

```ts
const navigation = {
  admin: {
    drawerTitle: "管理员导航",
    groups: ["客户与货品", "订单履约", "资金与数据", "系统管理"],
    label: "管理员主导航",
  },
  customer: {
    drawerTitle: "客户导航",
    groups: ["拿货", "订单与付款"],
    label: "客户主导航",
  },
} as const;
```

Replace each group-button assertion with:

```ts
for (const group of audience.groups) {
  await expect(desktopNavigation.getByRole("heading", { level: 2, name: group })).toBeVisible();
  await expect(desktopNavigation.getByRole("button", { name: group })).toHaveCount(0);
}
await expect(desktopNavigation.locator("[aria-expanded]")).toHaveCount(0);
```

For mobile, assert the same static headings and measure the first and last visible navigation links:

```ts
const mobileLinks = mobileNavigation.getByRole("link");
expect(await mobileLinks.count()).toBeGreaterThan(1);
for (const link of [mobileLinks.first(), mobileLinks.last()]) {
  const box = await link.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
}
```

- [ ] **Step 2: Run functional E2E before snapshot updates**

Run:

```powershell
npm.cmd run test:e2e -- tests/e2e/ui-v2-shell.spec.ts tests/e2e/ui-v2-responsive.spec.ts --workers 1
```

Expected: PASS with admin/customer coverage at 1440×900, 1920×1080, 430×900, 390×844, and 360×800; mobile Sheet closes and returns focus; axe serious/critical is zero; overflow and browser error arrays are empty.

- [ ] **Step 3: Run the existing visual suite once to record intentional RED diffs**

Run:

```powershell
npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --workers 1
```

Expected: screenshot assertions fail where the shell/navigation/button visuals changed. Product behavior, axe, overflow, and console/page/hydration assertions must already pass. If a functional assertion fails, fix the product or test contract before updating any image.

- [ ] **Step 4: Update and manually review unmasked baselines in one bounded pass**

Run:

```powershell
npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --workers 1 --update-snapshots
```

Review every changed PNG at its real dimensions. Confirm all five requirements in every changed baseline:

1. static labels have no border box or chevron;
2. current route is stronger than its group heading and has the 2px active rail;
3. no white vertical seam exists at x=224;
4. primary buttons are flat deep teal with no shadow/bounce styling;
5. no overlap, clipping, abnormal blank area, or horizontal overflow is introduced.

Do not use masks, transparent text, injected normalization CSS, or cropped evidence.

- [ ] **Step 5: Confirm snapshots without update mode and run the detector once**

Run:

```powershell
npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --workers 1
node .agents/skills/impeccable/scripts/detect.mjs --json src/components/layout src/components/ui/button.tsx src/components/forms/action-form.tsx src/components/forms/confirmed-action-form.tsx src/components/customers/create-customer-drawer.tsx
```

Expected: visual suite PASS; detector JSON contains no blocking findings. Record the detector output in the ignored Task 4 report rather than adding generated detector files to source control.

- [ ] **Step 6: Run complete local gates**

Run:

```powershell
npm.cmd test
npm.cmd run test:integration -- --maxWorkers 1
npm.cmd run test:e2e -- --workers 1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
git diff --check
```

Expected: full unit, integration, and E2E suites PASS with zero unexpected skips/failures; typecheck/lint/build/diff-check exit 0. If build requires environment variables, load the documented values from `.env.example` into the current process without editing or committing secrets.

- [ ] **Step 7: Write evidence and commit only the acceptance changes**

Write `.superpowers/sdd/2026-08-16-merchant-shell-navigation-buttons/task-4-report.md` with:

- exact RED and GREEN commands/results;
- changed screenshot inventory and manual-review verdict;
- viewport matrix;
- axe/overflow/console/hydration results;
- detector JSON result;
- final unit/integration/E2E/typecheck/lint/build counts.

Then stage only the E2E specs and changed tracked baselines:

```powershell
git add tests/e2e/ui-v2-shell.spec.ts tests/e2e/ui-v2-responsive.spec.ts tests/e2e/merchant-center-visual.spec.ts-snapshots
git diff --cached --check
git commit -m "test: approve merchant shell visual hierarchy"
```

Do not stage `.superpowers`, `.e2e-*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, archives, or unrelated schema tests.

---

## Final Review Gate

After Task 4, request an independent correctness/accessibility review of the complete commit range. The reviewer must verify:

- admin and customer route/permission lists are unchanged;
- no navigation localStorage, collapse state, chevron, or `aria-expanded` remains;
- active-route matching still chooses the longest valid route and handles exact query routes;
- sidebar/topbar width is sourced from one CSS variable and border ownership cannot recreate the white seam;
- buttons have no shadow or pressed translation and destructive final confirmation remains visually distinct;
- the full viewport/accessibility/error/snapshot matrix is genuine and unmasked.

Address Critical and Important findings with a fresh RED→GREEN fix commit, rerun the affected focused tests plus the complete gates, and append the fix evidence to the ignored Task 4 report.
