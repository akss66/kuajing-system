import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const IMMUTABLE_IMAGE_TAG = /^[0-9a-f]{7,40}$/;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export function validateReleaseMetadata(input: {
  appVersion: string | undefined;
  packageVersion: string | undefined;
  releaseSha: string | undefined;
}) {
  const appVersion = input.appVersion?.trim().toLowerCase() ?? "";
  const packageVersion = input.packageVersion?.trim() ?? "";
  const releaseSha = input.releaseSha?.trim().toLowerCase() ?? "";

  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    throw new Error("PACKAGE_VERSION must be a semantic version such as 0.2.0");
  }
  if (!IMMUTABLE_IMAGE_TAG.test(appVersion)) {
    throw new Error(
      "APP_VERSION must be the current immutable 7-40 character lowercase Git SHA; current/latest tags are forbidden",
    );
  }
  if (!FULL_GIT_SHA.test(releaseSha)) {
    throw new Error("RELEASE_SHA must be the current full 40 character lowercase Git SHA");
  }
  if (!releaseSha.startsWith(appVersion)) {
    throw new Error("APP_VERSION must be a prefix of RELEASE_SHA from the same commit");
  }

  return { appVersion, packageVersion, releaseSha };
}

function readPackageVersion() {
  const packageJson = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  ) as { version?: string };
  return packageJson.version;
}

function runCli() {
  const metadata = validateReleaseMetadata({
    appVersion: process.env.APP_VERSION,
    packageVersion: process.env.PACKAGE_VERSION ?? readPackageVersion(),
    releaseSha: process.env.RELEASE_SHA,
  });
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

const entryPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPath === import.meta.url) runCli();
