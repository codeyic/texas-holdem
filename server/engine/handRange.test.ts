import { describe, expect, it } from "vitest";
import { makeDeck, parseCards } from "../game/cards";
import { chenScore, holeKey, holeInRange, randomHoleFromRange } from "./handRange";

describe("起手牌范围", () => {
  it("holeKey 正确标识三类起手牌", () => {
    expect(holeKey(parseCards(["Ah", "Ad"]))).toBe("AA");
    expect(holeKey(parseCards(["Ah", "Kh"]))).toBe("AKs");
    expect(holeKey(parseCards(["Ah", "Kd"]))).toBe("AKo");
  });

  it("Chen 分值：口袋对 > 高张同花 > 非同花高张", () => {
    const aa = chenScore(parseCards(["Ah", "Ad"]));
    const aks = chenScore(parseCards(["Ah", "Kh"]));
    const ako = chenScore(parseCards(["Ah", "Kd"]));
    const weak = chenScore(parseCards(["2h", "7d"]));
    expect(aa).toBeGreaterThan(aks);
    expect(aks).toBeGreaterThan(ako);
    expect(ako).toBeGreaterThan(weak);
  });

  it("随机从范围抽牌不与已知死牌冲突", () => {
    const dead = parseCards(["Ah", "Kh", "2s", "3s", "4s"]);
    const hole = randomHoleFromRange({ topPct: 0.2 }, dead, () => 0.5)!;
    expect(hole).toHaveLength(2);
    expect(dead.some((d) => d.r === hole[0].r && d.s === hole[0].s)).toBe(false);
    expect(dead.some((d) => d.r === hole[1].r && d.s === hole[1].s)).toBe(false);
    expect(holeInRange({ topPct: 0.2 }, hole)).toBe(true);
  });

  it("随机范围任何手牌都在范围内", () => {
    const hole = randomHoleFromRange("random", [], () => 0.3)!;
    expect(holeInRange("random", hole)).toBe(true);
  });

  it("极紧范围排除弱牌", () => {
    const weak = parseCards(["2h", "7d"]);
    expect(holeInRange({ topPct: 0.05 }, weak)).toBe(false);
    const aa = parseCards(["Ah", "Ad"]);
    expect(holeInRange({ topPct: 0.05 }, aa)).toBe(true);
  });
});
