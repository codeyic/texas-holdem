import { describe, expect, it } from "vitest";
import { clampRaiseAmount, potRaiseTo } from "./raiseSize";

describe("加注金额", () => {
  it("超出范围时夹紧到最小或最大", () => {
    expect(clampRaiseAmount(10, 80, 900)).toBe(80);
    expect(clampRaiseAmount(9999, 80, 900)).toBe(900);
    expect(clampRaiseAmount(120.6, 80, 900)).toBe(121);
  });

  it("面对加注时按底池加跟注额算加注到", () => {
    const base = {
      pot: 1690,
      currentBet: 40,
      callAmount: 40,
      minRaiseTo: 80,
      maxRaiseTo: 2000,
    };
    expect(potRaiseTo({ ...base, fraction: 0.25 })).toBe(473);
    expect(potRaiseTo({ ...base, fraction: 0.5 })).toBe(905);
    expect(potRaiseTo({ ...base, fraction: 1 })).toBe(1770);
  });

  it("无人下注开池时按底池比例下注", () => {
    expect(
      potRaiseTo({
        pot: 100,
        currentBet: 0,
        callAmount: 0,
        minRaiseTo: 20,
        maxRaiseTo: 1000,
        fraction: 0.5,
      }),
    ).toBe(50);
  });
});
