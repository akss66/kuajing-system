export class InvalidExactUnitPriceError extends Error {
  constructor(message = "Unit price values must be non-negative safe integers") {
    super(message);
    this.name = "InvalidExactUnitPriceError";
  }
}

function assertNonNegativeSafeInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidExactUnitPriceError();
  }
}

export function fenToMilliYuan(fen: number) {
  assertNonNegativeSafeInteger(fen);
  const milliYuan = fen * 10;
  assertNonNegativeSafeInteger(milliYuan);
  return milliYuan;
}

export function calculateLineAmountFen(
  quantity: number,
  unitPriceMilliYuan: number,
) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new InvalidExactUnitPriceError("Quantity must be a positive safe integer");
  }
  assertNonNegativeSafeInteger(unitPriceMilliYuan);

  const amountFen =
    (BigInt(quantity) * BigInt(unitPriceMilliYuan) + 5n) / 10n;
  if (amountFen > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidExactUnitPriceError("Rounded line amount exceeds safe integer range");
  }
  return Number(amountFen);
}

export function roundMilliYuanToFen(unitPriceMilliYuan: number) {
  return calculateLineAmountFen(1, unitPriceMilliYuan);
}

export function formatMilliYuan(unitPriceMilliYuan: number) {
  assertNonNegativeSafeInteger(unitPriceMilliYuan);
  const value = (unitPriceMilliYuan / 1_000)
    .toFixed(3)
    .replace(/0$/, "");
  return `¥${value}`;
}
