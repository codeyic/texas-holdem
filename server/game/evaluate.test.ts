import { describe, expect, it } from "vitest";
import { parseCards } from "./cards";
import { bestHand, compareValue, evaluate5, handName } from "./evaluate";

describe("牌力评估", () => {
  it("同花顺大于四条", () => {
    const sf = evaluate5(parseCards(["As", "Ks", "Qs", "Js", "Ts"]));
    const quads = evaluate5(parseCards(["Ah", "Ad", "Ac", "As", "2h"]));
    expect(compareValue(sf, quads)).toBeGreaterThan(0);
    expect(handName(sf)).toBe("同花顺");
  });

  it("A2345 是最小顺子，输给 23456", () => {
    const wheel = evaluate5(parseCards(["Ah", "2d", "3c", "4s", "5h"]));
    const six = evaluate5(parseCards(["2h", "3d", "4c", "5s", "6h"]));
    expect(wheel[0]).toBe(4);
    expect(wheel[1]).toBe(5);
    expect(compareValue(six, wheel)).toBeGreaterThan(0);
  });

  it("葫芦大于同花", () => {
    const boat = evaluate5(parseCards(["9h", "9d", "9c", "2s", "2h"]));
    const flush = evaluate5(parseCards(["Ah", "Kh", "8h", "4h", "3h"]));
    expect(compareValue(boat, flush)).toBeGreaterThan(0);
  });

  it("七张牌取最强五张：一对A", () => {
    const v = bestHand(
      parseCards(["Ah", "Ad", "Kc", "Qs", "Jh", "9d", "2c"]),
    );
    expect(v[0]).toBe(1);
    expect(v[1]).toBe(14);
    expect(handName(v)).toBe("一对");
  });
});
