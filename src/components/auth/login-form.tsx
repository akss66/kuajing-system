"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/modules/identity/auth-client";

const inputClassName =
  "min-h-11 w-full rounded-[var(--radius-control)] border border-border bg-background px-3.5 text-[15px] text-ink shadow-[0_1px_1px_oklch(0.22_0.018_175/0.03)] transition-[border-color,box-shadow] duration-[var(--duration-fast)] placeholder:text-muted/75 hover:border-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const response = await authClient.signIn.email({
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      rememberMe: true,
    });

    if (response.error) {
      setError("邮箱或密码不正确，请检查后重试。");
      setPending(false);
      return;
    }

    const user = response.data?.user as
      | { customerId?: string | null; role?: string | null }
      | undefined;
    const roles = user?.role
      ?.split(",")
      .map((role) => role.trim())
      .filter(Boolean);
    const isAdministrator =
      roles?.includes("admin") || roles?.includes("super_admin");
    router.replace(isAdministrator ? "/admin" : "/portal");
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <label className="block text-sm font-medium text-ink" htmlFor="email">
          登录邮箱
        </label>
        <Input
          autoComplete="email"
          className={inputClassName}
          disabled={pending}
          id="email"
          name="email"
          placeholder="name@example.com"
          required
          type="email"
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-ink" htmlFor="password">
          登录密码
        </label>
        <Input
          autoComplete="current-password"
          className={inputClassName}
          disabled={pending}
          id="password"
          minLength={12}
          name="password"
          placeholder="请输入密码"
          required
          type="password"
        />
      </div>

      {error ? (
        <p className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        className="mt-1 flex min-h-11 w-full items-center justify-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-semibold text-white shadow-[0_1px_2px_oklch(0.22_0.018_175/0.12)] transition-[background-color,transform] duration-[var(--duration-fast)] hover:bg-primary-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
        {pending ? "正在登录" : "登录系统"}
      </Button>
    </form>
  );
}
