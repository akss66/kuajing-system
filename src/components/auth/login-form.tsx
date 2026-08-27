"use client";

import { Eye, EyeOff, LoaderCircle, LockKeyhole, Mail, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/modules/identity/auth-client";

const inputClassName =
  "login-input min-h-12 w-full rounded-[var(--radius-control)] border border-border bg-background px-3.5 text-base text-ink shadow-none transition-[background-color,border-color,box-shadow] duration-[var(--duration-fast)] hover:border-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15 md:text-[15px]";

const subscribeToHydration = () => () => undefined;

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const disabled = !hydrated || pending;

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
    <form action="/login" className="space-y-5" method="post" onSubmit={handleSubmit}>
      <div className="space-y-2.5">
        <label className="block text-sm font-medium text-ink" htmlFor="email">
          登录邮箱
        </label>
        <div className="relative">
          <Mail aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" />
          <Input
            autoComplete="email"
            className={`${inputClassName} pl-11`}
            disabled={disabled}
            id="email"
            name="email"
            required
            type="email"
          />
        </div>
      </div>

      <div className="space-y-2.5">
        <label className="block text-sm font-medium text-ink" htmlFor="password">
          登录密码
        </label>
        <div className="relative">
          <LockKeyhole aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" />
          <Input
            autoComplete="current-password"
            className={`${inputClassName} px-11`}
            disabled={disabled}
            id="password"
            minLength={12}
            name="password"
            required
            type={passwordVisible ? "text" : "password"}
          />
          <button
            aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
            aria-pressed={passwordVisible}
            className="absolute right-0.5 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-[var(--duration-fast)] hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            onClick={() => setPasswordVisible((visible) => !visible)}
            type="button"
          >
            {passwordVisible ? <EyeOff aria-hidden="true" className="size-[18px]" /> : <Eye aria-hidden="true" className="size-[18px]" />}
          </button>
        </div>
      </div>

      {error ? (
        <p className="flex items-start gap-2.5 rounded-xl bg-danger/5 px-3.5 py-3 text-sm leading-5 text-danger" role="alert">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <Button
        className="mt-1 flex min-h-12 w-full items-center justify-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-semibold text-white shadow-none transition-[background-color,transform] duration-[var(--duration-fast)] hover:bg-primary-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        type="submit"
      >
        {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
        {pending ? "正在登录" : "登录系统"}
      </Button>
    </form>
  );
}
