import { describe, expect, it } from "vitest";
import { parseCards } from "../game/cards";
import { winEquity } from "./equity";

describe("胜率引擎", () => {
  it("翻前 AA vs 随机：胜率明显占优", () => {
    const eq = winEquity({
      heroCards: parseCards(["Ah", "Ad"]),
      community: [],
      opponents: ["random"],
      iterations: 2000,
    });
    expect(eq.win).toBeGreaterThan(0.75);
    expect(eq.lose).toBeLessThan(0.25);
  });

  it("翻前 72o vs 随机：明显劣势", () => {
    const eq = winEquity({
      heroCards: parseCards(["2h", "7d"]),
      community: [],
      opponents: ["random"],
      iterations: 2000,
    });
    expect(eq.win).toBeLessThan(0.5);
  });

  it("翻后河牌已定：按公共牌精确判定", () => {
    // 自己 Ah Kh 已成皇家同花顺，任意随机对手均无法反超 → 精确判定 win=1
    const eq = winEquity({
      heroCards: parseCards(["Ah", "Kh"]),
      community: parseCards(["Qh", "Jh", "Th", "2c", "3d"]),
      opponents: ["random"],
    });
    expect(eq.win).toBe(1);
    expect(eq.tie).toBe(0);
  });

  it("翻后转牌：枚举剩余河牌", () => {
    // 自己 Ah Kh 顶对 A 带 K 踢脚（转牌 4 张公共牌），枚举 1 张河牌，对 random 明显占优
    const eq = winEquity({
      heroCards: parseCards(["Ah", "Kh"]),
      community: parseCards(["As", "7d", "9s", "2c"]),
      opponents: ["random"],
      iterations: 200,
    });
    expect(eq.win).toBeGreaterThan(0.6);
  });
});
