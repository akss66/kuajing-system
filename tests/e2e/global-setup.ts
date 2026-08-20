export default async function globalSetup() {
  await import("../../scripts/prepare-test-database");
}
