import { describe, expect, it } from "vitest";
import { buildPots } from "./pots";

describe("边池", () => {
  it("一人全下拆出主池和边池", () => {
    const pots = buildPots([
      { id: "a", amount: 100, folded: false },
      { id: "b", amount: 200, folded: false },
      { id: "c", amount: 200, folded: false },
    ]);
    expect(pots).toEqual([
      { amount: 300, eligible: ["a", "b", "c"] },
      { amount: 200, eligible: ["b", "c"] },
    ]);
  });

  it("弃牌玩家的筹码仍进池但不能赢", () => {
    const pots = buildPots([
      { id: "a", amount: 50, folded: true },
      { id: "b", amount: 50, folded: false },
    ]);
    expect(pots).toEqual([{ amount: 100, eligible: ["b"] }]);
  });
});
