import { describe, expect, it } from "vitest";
import { feltSeatLayout, feltSeatRail } from "./feltSeat";

describe("牌桌座位布局", () => {
  it("自己在正南且整块座位向下挂，不盖向桌心", () => {
    const you = feltSeatLayout(0, 5);
    expect(you.left).toBeCloseTo(50, 5);
    expect(you.top).toBeGreaterThan(80);
    expect(you.tx).toBeCloseTo(-50, 5);
    expect(you.ty).toBeGreaterThan(-20);
  });

  it("对家在北侧向上挂", () => {
    const north = feltSeatLayout(1, 2);
    expect(north.top).toBeLessThan(20);
    expect(north.ty).toBeLessThan(-80);
  });

  it("5到8人时左右座位都留在桌内，手牌不会只露出一张", () => {
    const seatWidthPct = 32;
    for (const n of [5, 6, 7, 8]) {
      for (let i = 0; i < n; i += 1) {
        const p = feltSeatLayout(i, n);
        const leftEdge = p.left + (p.tx / 100) * seatWidthPct;
        const rightEdge = leftEdge + seatWidthPct;
        expect(leftEdge).toBeGreaterThan(1);
        expect(rightEdge).toBeLessThan(99);
      }
    }
  });

  it("8人时左前方座位算西侧，手牌竖排不会被裁成一张", () => {
    expect(feltSeatLayout(1, 8).side).toBe("west");
    expect(feltSeatLayout(7, 8).side).toBe("east");
    expect(feltSeatLayout(0, 8).side).toBe("south");
  });

  it("8人分到四边栏，自己在南、不和公共牌抢位置", () => {
    expect(feltSeatRail(0, 8)).toBe("south");
    expect(feltSeatRail(1, 8)).toBe("west");
    expect(feltSeatRail(2, 8)).toBe("west");
    expect(feltSeatRail(3, 8)).toBe("north");
    expect(feltSeatRail(4, 8)).toBe("north");
    expect(feltSeatRail(5, 8)).toBe("north");
    expect(feltSeatRail(6, 8)).toBe("east");
    expect(feltSeatRail(7, 8)).toBe("east");
  });
});
