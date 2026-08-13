import { auth } from "./auth";

export type AdminPrincipal = {
  kind: "ADMIN";
  userId: string;
};

export type SuperAdminPrincipal = {
  kind: "SUPER_ADMIN";
  userId: string;
};

export type CustomerPrincipal = {
  kind: "CUSTOMER";
  userId: string;
  customerId: string;
};

export type Principal = AdminPrincipal | CustomerPrincipal | SuperAdminPrincipal;
export type PrincipalResolver = () => Promise<Principal | null>;

export type AuthenticatedIdentity = {
  displayName: string | null;
  email: string;
};

export type AuthenticatedPrincipal = {
  identity: AuthenticatedIdentity;
  principal: Principal;
};

export async function getCurrentAuthenticatedPrincipal(
  requestHeaders?: Headers,
): Promise<AuthenticatedPrincipal | null> {
  const resolvedHeaders =
    requestHeaders ?? (await (await import("next/headers")).headers());
  const session = await auth.api.getSession({ headers: resolvedHeaders });

  if (!session) return null;

  const role = session.user.role
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const identity: AuthenticatedIdentity = {
    displayName: session.user.name?.trim() || null,
    email: session.user.email,
  };

  if (role?.includes("super_admin")) {
    return {
      identity,
      principal: { kind: "SUPER_ADMIN", userId: session.user.id },
    };
  }

  if (role?.includes("admin")) {
    return {
      identity,
      principal: { kind: "ADMIN", userId: session.user.id },
    };
  }

  if (session.user.customerId) {
    return {
      identity,
      principal: {
        kind: "CUSTOMER",
        customerId: session.user.customerId,
        userId: session.user.id,
      },
    };
  }

  return null;
}

export async function getCurrentPrincipal(
  requestHeaders?: Headers,
): Promise<Principal | null> {
  return (await getCurrentAuthenticatedPrincipal(requestHeaders))?.principal ?? null;
}
