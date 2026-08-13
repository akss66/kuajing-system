import { pathToFileURL } from "node:url";

import { JifengApiError, JifengClient } from "./client";
import {
  inspectJifengConfiguration,
  readJifengAuthorizedConfig,
  type JifengAuthorizedConfig,
  type JifengConfigurationLevel,
} from "./config";
import {
  buildJifengCanonicalString,
  signJifengRequest,
  type JifengSigningInput,
} from "./signing";
import { redactSensitiveText } from "@/shared/privacy";

type EnvironmentSource = Record<string, string | undefined>;
type OrderClient = Pick<JifengClient, "getOrder">;

type RemoteProbeOutcome =
  | "AUTHENTICATION_REJECTED"
  | "MISSING_AUTHORIZED_FIELDS"
  | "ORDER_NOT_FOUND_CONFIRMED"
  | "QUERY_RETURNED_ORDER"
  | "REQUEST_REJECTED";

export type JifengConnectivityDiagnosticResult = {
  configurationLevel: JifengConfigurationLevel;
  localSelfCheck: {
    canonicalString: string;
    expectedCanonicalString: string;
    expectedSignature: string;
    ok: boolean;
    signature: string;
    source: string;
  };
  remoteProbe:
    | {
        attempted: false;
        missingFields: string[];
        outcome: "MISSING_AUTHORIZED_FIELDS";
      }
    | {
        attempted: true;
        code?: string;
        message?: string;
        outcome: Exclude<RemoteProbeOutcome, "MISSING_AUTHORIZED_FIELDS">;
        probeErpNo: string;
        requestId?: string;
        retryable?: boolean;
      };
  status: "LOCAL_ONLY" | "REMOTE_FAILED" | "REMOTE_OK";
};

const OFFICIAL_DOC_SOURCE =
  "https://s.apifox.cn/25bf1c44-f535-4c37-9bf4-7244130a67ce/doc-3651609.md";
const ORDER_NOT_FOUND_CODES = new Set(["50017", "50071"]);
const AUTHENTICATION_CODES = new Set([
  "10002",
  "10003",
  "10004",
  "10005",
  "10006",
  "10007",
  "10008",
  "10009",
  "10010",
  "10011",
  "10013",
  "10014",
  "10015",
  "10016",
  "10020",
  "10021",
  "10022",
  "10023",
  "10024",
  "10025",
  "10026",
  "10028",
  "10029",
  "10040",
  "10041",
  "10042",
  "10050",
  "HTTP_401",
  "HTTP_403",
]);

function runLocalSigningSelfCheck() {
  const input: JifengSigningInput = {
    accessToken: "1b56814f081c432cb82751be145261d3",
    clientId: "fe73489a9b5948dbafd07e7b28d6e268",
    method: "post",
    nonce: "14",
    timestamp: "1692889556000",
    url: "/api/order/get",
    userId: "8",
  };
  const expectedCanonicalString =
    "accessToken=1b56814f081c432cb82751be145261d3&clientId=fe73489a9b5948dbafd07e7b28d6e268&method=post&nonce=14&timestamp=1692889556000&url=/api/order/get&userId=8";
  const expectedSignature =
    "9bc08ba7552c5dfea4efab6bda78a4a9738010913f2403bd93f09c6bf974b939";
  const canonicalString = buildJifengCanonicalString(input);
  const signature = signJifengRequest(
    "4a506ccaf37e400bac4a42d2dc5f600a",
    input,
  );

  return {
    canonicalString,
    expectedCanonicalString,
    expectedSignature,
    ok:
      canonicalString === expectedCanonicalString &&
      signature === expectedSignature,
    signature,
    source: OFFICIAL_DOC_SOURCE,
  };
}

function defaultProbeErpNo(now: Date) {
  return `TZX-JF-CONNECTIVITY-${now.toISOString().replace(/\D/g, "").slice(0, 14)}`;
}

function classifyFailure(
  code?: string,
): Exclude<RemoteProbeOutcome, "MISSING_AUTHORIZED_FIELDS"> {
  if (code && AUTHENTICATION_CODES.has(code)) {
    return "AUTHENTICATION_REJECTED";
  }
  return "REQUEST_REJECTED";
}

function buildClient(
  authorizedConfig: JifengAuthorizedConfig,
  client?: OrderClient,
  timeoutMs = 10_000,
) {
  if (client) return client;
  return new JifengClient({ credentials: authorizedConfig, timeoutMs });
}

export async function runJifengConnectivityDiagnostic(input: {
  baseUrlOverride?: string;
  client?: OrderClient;
  environment?: EnvironmentSource;
  nodeEnv?: string;
  now?: Date;
  probeErpNo?: string;
  timeoutMs?: number;
} = {}): Promise<JifengConnectivityDiagnosticResult> {
  const environment = input.environment ?? process.env;
  const localSelfCheck = runLocalSigningSelfCheck();
  const configuration = inspectJifengConfiguration(environment, {
    baseUrlOverride: input.baseUrlOverride,
    nodeEnv: input.nodeEnv,
  });

  if (!configuration.authorized.configured) {
    const missingFields = [
      ...configuration.authorized.missingFields,
      ...configuration.authorized.invalidFields,
    ];
    return {
      configurationLevel: configuration.level,
      localSelfCheck,
      remoteProbe: {
        attempted: false,
        missingFields: [...new Set(missingFields)].sort(),
        outcome: "MISSING_AUTHORIZED_FIELDS",
      },
      status: "LOCAL_ONLY",
    };
  }

  const authorizedConfig = readJifengAuthorizedConfig(environment, {
    baseUrlOverride: input.baseUrlOverride,
    nodeEnv: input.nodeEnv,
  });
  const now = input.now ?? new Date();
  const probeErpNo = input.probeErpNo ?? defaultProbeErpNo(now);
  const client = buildClient(authorizedConfig, input.client, input.timeoutMs);

  try {
    await client.getOrder({ erpNo: probeErpNo });
    return {
      configurationLevel: configuration.level,
      localSelfCheck,
      remoteProbe: {
        attempted: true,
        outcome: "QUERY_RETURNED_ORDER",
        probeErpNo,
      },
      status: "REMOTE_OK",
    };
  } catch (error) {
    if (error instanceof JifengApiError && ORDER_NOT_FOUND_CODES.has(error.code)) {
      return {
        configurationLevel: configuration.level,
        localSelfCheck,
        remoteProbe: {
          attempted: true,
          code: error.code,
          message: redactSensitiveText(error.message),
          outcome: "ORDER_NOT_FOUND_CONFIRMED",
          probeErpNo,
          requestId: error.requestId,
          retryable: error.retryable,
        },
        status: "REMOTE_OK",
      };
    }

    if (error instanceof JifengApiError) {
      return {
        configurationLevel: configuration.level,
        localSelfCheck,
        remoteProbe: {
          attempted: true,
          code: error.code,
          message: redactSensitiveText(error.message),
          outcome: classifyFailure(error.code),
          probeErpNo,
          requestId: error.requestId,
          retryable: error.retryable,
        },
        status: "REMOTE_FAILED",
      };
    }

    return {
      configurationLevel: configuration.level,
      localSelfCheck,
      remoteProbe: {
        attempted: true,
        message: redactSensitiveText(String(error)),
        outcome: "REQUEST_REJECTED",
        probeErpNo,
      },
      status: "REMOTE_FAILED",
    };
  }
}

async function runFromCli() {
  const result = await runJifengConnectivityDiagnostic();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "REMOTE_FAILED" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromCli();
}
