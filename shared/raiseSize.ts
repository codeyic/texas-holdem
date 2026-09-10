/**
 * 加注金额：滑条/输入框夹紧，以及常见底池比例快捷键。
 * 「加注到」= 当前注 + (底池 + 跟注额) × 比例，与常见线上德扑一致。
 */

export const POT_RAISE_PRESETS: { fraction: number; label: string }[] = [
  { fraction: 0.25, label: "1/4池" },
  { fraction: 0.5, label: "1/2池" },
  { fraction: 0.75, label: "3/4池" },
  { fraction: 1, label: "满池" },
];

export function clampRaiseAmount(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  let next = Math.round(value);
  if (next < min) {
    return min;
  }
  if (next > max) {
    return max;
  }
  return next;
}

export function potRaiseTo(opts: {
  pot: number;
  currentBet: number;
  callAmount: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  fraction: number;
}): number {
  const extra = Math.round((opts.pot + opts.callAmount) * opts.fraction);
  return clampRaiseAmount(
    opts.currentBet + extra,
    opts.minRaiseTo,
    opts.maxRaiseTo,
  );
}
