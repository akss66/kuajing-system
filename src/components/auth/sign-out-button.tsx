"use client";

import { LoaderCircle, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/modules/identity/auth-client";

type SignOutButtonProps = {
  className?: string;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
};

const signOutErrorMessage = "退出登录失败，请稍后再试。";

export function SignOutButton({
  className,
  size = "default",
  variant = "outline",
}: SignOutButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setPending(true);
    setError(null);

    try {
      const response = await authClient.signOut();
      if (response.error) {
        setError(signOutErrorMessage);
        return;
      }

      router.replace("/login");
      router.refresh();
    } catch {
      setError(signOutErrorMessage);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-2">
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        aria-label={pending ? "正在退出登录" : "退出登录"}
        className={className}
        disabled={pending}
        onClick={handleSignOut}
        size={size}
        type="button"
        variant={variant}
      >
        {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <LogOut aria-hidden="true" />}
        {pending ? "正在退出登录" : "退出登录"}
      </Button>
    </div>
  );
}
