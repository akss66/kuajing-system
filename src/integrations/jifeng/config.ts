import { z } from "zod";

import type { JifengCredentials } from "./types";

type EnvironmentSource = Record<string, string | undefined>;
type BaseUrlOverrideOptions = {
  baseUrlOverride?: string;
  nodeEnv?: string;
};

const developerCredentialsSchema = z.object({
  JIFENG_CLIENT_ID: z.string().min(1),
  JIFENG_CLIENT_SECRET: z.string().min(1),
});

const AUTHORIZATION_DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

export function normalizeJifengBaseUrl(value: string, nodeEnv?: string) {
  const url = new URL(value);
  const isHttps = url.protocol === "https:";
  const isAllowedLoopbackHttp =
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname);
  if (
    (!isHttps && !isAllowedLoopbackHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid Jifeng base URL");
  }
  return url.origin;
}

function baseUrlSchema(nodeEnv?: string) {
  return z.string().transform((value, context) => {
    try {
      return normalizeJifengBaseUrl(value, nodeEnv);
    } catch {
      context.addIssue({ code: "custom", message: "invalid Jifeng base URL" });
      return z.NEVER;
    }
  });
}

function oauthDeveloperSchema(nodeEnv?: string) {
  return developerCredentialsSchema.extend({
    JIFENG_BASE_URL: baseUrlSchema(nodeEnv),
    JIFENG_DOMAIN: z.string().regex(AUTHORIZATION_DOMAIN_PATTERN),
    JIFENG_TOKEN_ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) =>
          BASE64URL_KEY_PATTERN.test(value) || BASE64_KEY_PATTERN.test(value),
      ),
  });
}

function authorizedSchema(nodeEnv?: string) {
  return developerCredentialsSchema.extend({
    JIFENG_ACCESS_TOKEN: z.string().min(1),
    JIFENG_BASE_URL: baseUrlSchema(nodeEnv),
    JIFENG_REFRESH_TOKEN: z.string().min(1).optional(),
    JIFENG_USER_ID: z.string().min(1),
  });
}

function fulfillmentSchema(nodeEnv?: string) {
  return authorizedSchema(nodeEnv).extend({
    JIFENG_LOGISTICS_ID: z.coerce.number().int().positive(),
    JIFENG_WAREHOUSE_CODE: z.string().min(1),
  });
}

const developerFields = [
  "JIFENG_BASE_URL",
  "JIFENG_CLIENT_ID",
  "JIFENG_CLIENT_SECRET",
  "JIFENG_DOMAIN",
  "JIFENG_TOKEN_ENCRYPTION_KEY",
] as const;
const authorizedFields = [
  "JIFENG_ACCESS_TOKEN",
  "JIFENG_BASE_URL",
  "JIFENG_CLIENT_ID",
  "JIFENG_CLIENT_SECRET",
  "JIFENG_USER_ID",
] as const;
const fulfillmentFields = [
  "JIFENG_ACCESS_TOKEN",
  "JIFENG_BASE_URL",
  "JIFENG_CLIENT_ID",
  "JIFENG_CLIENT_SECRET",
  "JIFENG_LOGISTICS_ID",
  "JIFENG_USER_ID",
  "JIFENG_WAREHOUSE_CODE",
] as const;

type ConfiguredField =
  | (typeof developerFields)[number]
  | (typeof authorizedFields)[number]
  | (typeof fulfillmentFields)[number]
  | "JIFENG_REFRESH_TOKEN";

type FieldInspection = {
  configured: boolean;
  invalidFields: string[];
  missingFields: string[];
};

type ParsedFieldInspection<T> = FieldInspection & {
  value?: T;
};

export type JifengDeveloperConfig = Pick<
  JifengCredentials,
  "clientId" | "clientSecret"
>;
export type JifengAuthorizedConfig = JifengCredentials;
export type JifengIntegrationConfig = JifengAuthorizedConfig & {
  logisticsId: number;
  warehouseCode: string;
};
export type JifengConfigurationLevel =
  | "UNCONFIGURED"
  | "DEVELOPER_ONLY"
  | "AUTHORIZED_ONLY"
  | "FULFILLMENT_READY";
export type JifengConfigurationState = {
  anyConfigured: boolean;
  authorized: FieldInspection;
  developer: FieldInspection;
  fulfillment: FieldInspection;
  level: JifengConfigurationLevel;
};

const allKnownFields = [
  ...new Set<ConfiguredField>([
    ...developerFields,
    ...authorizedFields,
    ...fulfillmentFields,
    "JIFENG_REFRESH_TOKEN",
  ]),
];

export class JifengConfigError extends Error {
  readonly invalidFields: string[];
  readonly missingFields: string[];

  constructor(input: {
    invalidFields?: string[];
    message: string;
    missingFields?: string[];
  }) {
    super(input.message);
    this.name = "JifengConfigError";
    this.invalidFields = input.invalidFields ?? [];
    this.missingFields = input.missingFields ?? [];
  }
}

function fieldNamesFromIssues(
  environment: EnvironmentSource,
  issues: Array<{ path: PropertyKey[] }>,
) {
  const missing = new Set<string>();
  const invalid = new Set<string>();

  for (const issue of issues) {
    const [field] = issue.path;
    if (typeof field !== "string") continue;
    const raw = environment[field];
    if (raw === undefined || raw.trim() === "") {
      missing.add(field);
      continue;
    }
    invalid.add(field);
  }

  return {
    invalidFields: [...invalid].sort(),
    missingFields: [...missing].sort(),
  };
}

function inspectSchema<T>(
  schema: z.ZodType<T>,
  environment: EnvironmentSource,
): ParsedFieldInspection<T> {
  const parsed = schema.safeParse(environment);
  if (parsed.success) {
    return {
      configured: true,
      invalidFields: [],
      missingFields: [],
      value: parsed.data,
    };
  }

  const { invalidFields, missingFields } = fieldNamesFromIssues(
    environment,
    parsed.error.issues,
  );
  return { configured: false, invalidFields, missingFields };
}

function toPublicInspection(inspection: FieldInspection): FieldInspection {
  return {
    configured: inspection.configured,
    invalidFields: inspection.invalidFields,
    missingFields: inspection.missingFields,
  };
}

function describeFields(label: string, fields: string[]) {
  if (fields.length === 0) return "";
  return `${label}: ${fields.join(", ")}`;
}

function buildConfigErrorMessage(scope: string, inspection: FieldInspection) {
  const details = [
    describeFields("missing", inspection.missingFields),
    describeFields("invalid", inspection.invalidFields),
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  return `Jifeng ${scope} configuration is incomplete${suffix}`;
}

function throwForInspection(scope: string, inspection: FieldInspection): never {
  throw new JifengConfigError({
    invalidFields: inspection.invalidFields,
    message: buildConfigErrorMessage(scope, inspection),
    missingFields: inspection.missingFields,
  });
}

function normalizeEnvironment(
  environment: EnvironmentSource,
  options?: BaseUrlOverrideOptions,
) {
  if (!options?.baseUrlOverride) return environment;

  const nodeEnv = options.nodeEnv ?? environment.NODE_ENV;
  if (nodeEnv === "production") {
    throw new JifengConfigError({
      invalidFields: ["JIFENG_BASE_URL"],
      message: "JIFENG_BASE_URL override is not allowed in production",
    });
  }

  return {
    ...environment,
    JIFENG_BASE_URL: options.baseUrlOverride,
  };
}

function resolveNodeEnvironment(
  environment: EnvironmentSource,
  options?: BaseUrlOverrideOptions,
) {
  return options?.nodeEnv ?? environment.NODE_ENV ?? process.env.NODE_ENV;
}

function determineLevel(state: Omit<JifengConfigurationState, "level">) {
  if (state.fulfillment.configured) return "FULFILLMENT_READY";
  if (state.authorized.configured) return "AUTHORIZED_ONLY";
  if (state.developer.configured) return "DEVELOPER_ONLY";
  return "UNCONFIGURED";
}

export function inspectJifengConfiguration(
  environment: EnvironmentSource = process.env,
  options?: BaseUrlOverrideOptions,
): JifengConfigurationState {
  const normalized = normalizeEnvironment(environment, options);
  const nodeEnv = resolveNodeEnvironment(environment, options);
  const developer = toPublicInspection(
    inspectSchema(oauthDeveloperSchema(nodeEnv), normalized),
  );
  const authorized = toPublicInspection(
    inspectSchema(authorizedSchema(nodeEnv), normalized),
  );
  const fulfillment = toPublicInspection(
    inspectSchema(fulfillmentSchema(nodeEnv), normalized),
  );
  const anyConfigured = allKnownFields.some((field) => {
    const value = normalized[field];
    return typeof value === "string" && value.trim().length > 0;
  });

  const state = { anyConfigured, authorized, developer, fulfillment };
  return {
    ...state,
    level: determineLevel(state),
  };
}

export function readJifengDeveloperConfig(
  environment: EnvironmentSource = process.env,
): JifengDeveloperConfig {
  const inspection = inspectSchema(developerCredentialsSchema, environment);
  if (!inspection.configured || !inspection.value) {
    throwForInspection("developer", inspection);
  }

  return {
    clientId: inspection.value.JIFENG_CLIENT_ID,
    clientSecret: inspection.value.JIFENG_CLIENT_SECRET,
  };
}

export function readJifengAuthorizedConfig(
  environment: EnvironmentSource = process.env,
  options?: BaseUrlOverrideOptions,
): JifengAuthorizedConfig {
  const normalized = normalizeEnvironment(environment, options);
  const inspection = inspectSchema(
    authorizedSchema(resolveNodeEnvironment(environment, options)),
    normalized,
  );
  if (!inspection.configured || !inspection.value) {
    throwForInspection("authorized", inspection);
  }

  return {
    accessToken: inspection.value.JIFENG_ACCESS_TOKEN,
    baseUrl: inspection.value.JIFENG_BASE_URL,
    clientId: inspection.value.JIFENG_CLIENT_ID,
    clientSecret: inspection.value.JIFENG_CLIENT_SECRET,
    refreshToken: inspection.value.JIFENG_REFRESH_TOKEN,
    userId: inspection.value.JIFENG_USER_ID,
  };
}

export function readJifengConfig(
  environment: EnvironmentSource = process.env,
  options?: BaseUrlOverrideOptions,
): JifengIntegrationConfig {
  const normalized = normalizeEnvironment(environment, options);
  const inspection = inspectSchema(
    fulfillmentSchema(resolveNodeEnvironment(environment, options)),
    normalized,
  );
  if (!inspection.configured || !inspection.value) {
    throwForInspection("fulfillment", inspection);
  }

  return {
    accessToken: inspection.value.JIFENG_ACCESS_TOKEN,
    baseUrl: inspection.value.JIFENG_BASE_URL,
    clientId: inspection.value.JIFENG_CLIENT_ID,
    clientSecret: inspection.value.JIFENG_CLIENT_SECRET,
    logisticsId: inspection.value.JIFENG_LOGISTICS_ID,
    refreshToken: inspection.value.JIFENG_REFRESH_TOKEN,
    userId: inspection.value.JIFENG_USER_ID,
    warehouseCode: inspection.value.JIFENG_WAREHOUSE_CODE,
  };
}
