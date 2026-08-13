import { z } from "zod";

import type { JifengCredentials } from "./types";

type EnvironmentSource = Record<string, string | undefined>;
type BaseUrlOverrideOptions = {
  baseUrlOverride?: string;
  nodeEnv?: string;
};

const developerSchema = z.object({
  JIFENG_CLIENT_ID: z.string().min(1),
  JIFENG_CLIENT_SECRET: z.string().min(1),
});

const authorizedSchema = developerSchema.extend({
  JIFENG_ACCESS_TOKEN: z.string().min(1),
  JIFENG_BASE_URL: z.url().transform((value) => value.replace(/\/$/, "")),
  JIFENG_REFRESH_TOKEN: z.string().min(1).optional(),
  JIFENG_USER_ID: z.string().min(1),
});

const fulfillmentSchema = authorizedSchema.extend({
  JIFENG_LOGISTICS_ID: z.coerce.number().int().positive(),
  JIFENG_WAREHOUSE_CODE: z.string().min(1),
});

const developerFields = [
  "JIFENG_CLIENT_ID",
  "JIFENG_CLIENT_SECRET",
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
  const developer = toPublicInspection(
    inspectSchema(developerSchema, normalized),
  );
  const authorized = toPublicInspection(
    inspectSchema(authorizedSchema, normalized),
  );
  const fulfillment = toPublicInspection(
    inspectSchema(fulfillmentSchema, normalized),
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
  const inspection = inspectSchema(developerSchema, environment);
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
  const inspection = inspectSchema(authorizedSchema, normalized);
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
  const inspection = inspectSchema(fulfillmentSchema, normalized);
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
