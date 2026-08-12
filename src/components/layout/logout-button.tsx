"use client";

import { LoaderCircle, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/modules/identity/auth-client";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogout() {
    setPending(true);
    setError(null);

    const response = await authClient.signOut();
    if (response.error) {
      setError("退出失败，请刷新后重试。");
      setPending(false);
      return;
    }

    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <p className="hidden text-xs text-danger xl:block" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        aria-label="退出系统"
        className="min-h-11 gap-2"
        disabled={pending}
        onClick={handleLogout}
        type="button"
        variant="outline"
      >
        {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <LogOut aria-hidden="true" />}
        {pending ? "正在退出" : "退出"}
      </Button>
    </div>
  );
}
