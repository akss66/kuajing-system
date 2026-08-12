import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins";

import { db } from "@/db/client";
import { betterAuthSchema } from "@/db/schema";
import { BRAND } from "@/shared/brand";

const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL;

if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
if (!baseURL) throw new Error("BETTER_AUTH_URL is required");
const useSecureCookies = baseURL.startsWith("https://");

export const auth = betterAuth({
  appName: BRAND.name,
  baseURL,
  secret,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: betterAuthSchema,
    transaction: true,
  }),
  emailAndPassword: {
    disableSignUp: true,
    enabled: true,
    minPasswordLength: 12,
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: useSecureCookies,
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path !== "/admin/create-user") return;

      const password = context.body?.password;
      if (typeof password !== "string" || password.length < 12) {
        throw new APIError("BAD_REQUEST", {
          code: "PASSWORD_TOO_SHORT",
          message: "Password must be at least 12 characters",
        });
      }
    }),
  },
  user: {
    additionalFields: {
      customerId: {
        input: false,
        required: false,
        type: "string",
      },
    },
  },
  plugins: [admin()],
});
