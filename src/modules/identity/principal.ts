import { auth } from "./auth";

export type AdminPrincipal = {
  kind: "ADMIN";
  userId: string;
};

export type CustomerPrincipal = {
  kind: "CUSTOMER";
  userId: string;
  customerId: string;
};

export type Principal = AdminPrincipal | CustomerPrincipal;
export type PrincipalResolver = () => Promise<Principal | null>;

export async function getCurrentPrincipal(
  requestHeaders?: Headers,
): Promise<Principal | null> {
  const resolvedHeaders =
    requestHeaders ?? (await (await import("next/headers")).headers());
  const session = await auth.api.getSession({ headers: resolvedHeaders });

  if (!session) return null;

  const role = session.user.role
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (role?.includes("admin")) {
    return { kind: "ADMIN", userId: session.user.id };
  }

  if (session.user.customerId) {
    return {
      kind: "CUSTOMER",
      customerId: session.user.customerId,
      userId: session.user.id,
    };
  }

  return null;
}
