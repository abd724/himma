/**
 * W5-4 correction — marketplace commission arithmetic (owner ruling
 * D-W5-7, docs/33 §14.1).
 *
 * INTEGER FILS ONLY — no floating-point currency arithmetic anywhere.
 * The owner rounding rule: commission = roundHalfUp(basis × rateBps /
 * 10_000), computed as integer math ((basis·rate + 5000) div 10000 —
 * the +5000 against the fixed 10000 divisor IS round-half-up), then
 * providerShare = basis − commission, so the split reconciles EXACTLY by
 * construction (the 0016 CHECK is the database's last line).
 *
 * The safe integer range covers every representable amount by orders of
 * magnitude (basis ≤ ~9e11 fils before basis·rate approaches 2^53); the
 * guard below makes an overflow loud rather than silently wrong.
 */

export interface CommissionSplit {
  commissionBasisAmountFils: number;
  platformCommissionRateBps: number;
  platformCommissionAmountFils: number;
  providerShareAmountFils: number;
}

export function computeCommissionSplit(
  basisAmountFils: number,
  rateBps: number,
): CommissionSplit {
  if (!Number.isInteger(basisAmountFils) || basisAmountFils < 0) {
    throw new Error(`commission basis must be a non-negative integer (got ${basisAmountFils})`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new Error(`commission rate must be integer basis points in [0, 10000] (got ${rateBps})`);
  }
  const scaled = basisAmountFils * rateBps;
  if (!Number.isSafeInteger(scaled + 5000)) {
    throw new Error('commission computation exceeds the safe integer range');
  }
  const platformCommissionAmountFils = Math.floor((scaled + 5000) / 10000);
  return {
    commissionBasisAmountFils: basisAmountFils,
    platformCommissionRateBps: rateBps,
    platformCommissionAmountFils,
    providerShareAmountFils: basisAmountFils - platformCommissionAmountFils,
  };
}
