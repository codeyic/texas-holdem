/**
 * 牌桌座位：椭圆锚点（兼容旧测）与四边栏位（实际 UI，避免叠在公共牌上）。
 */

export type FeltSeatSide = "south" | "north" | "west" | "east" | "mid";
export type FeltRail = "south" | "north" | "west" | "east";

export function feltSeatLayout(
  index: number,
  count: number,
  wide = false,
): {
  left: number;
  top: number;
  tx: number;
  ty: number;
  side: FeltSeatSide;
} {
  const n = Math.max(count, 1);
  const theta = Math.PI / 2 + (2 * Math.PI * index) / n;
  const cx = Math.cos(theta);
  const sy = Math.sin(theta);
  const rx = wide ? 46 : 34;
  const ry = wide ? 36 : 32;
  let left = 50 + rx * cx;
  let top = 50 + ry * sy;
  const tx = -50 - (wide ? 6 : 16) * cx;
  const ty = -50 + (wide ? 10 : 36) * sy;
  if (wide) {
    left = Math.min(92, Math.max(8, left));
    top = Math.min(88, Math.max(12, top));
  } else {
    left = Math.min(80, Math.max(20, left));
    top = Math.min(84, Math.max(16, top));
  }
  let side: FeltSeatSide = "east";
  if (Math.abs(cx) < 0.28 && sy > 0) {
    side = "south";
  } else if (Math.abs(cx) < 0.28 && sy < 0) {
    side = "north";
  } else if (cx < 0) {
    side = "west";
  }
  return { left, top, tx, ty, side };
}

export function feltSeatRail(index: number, count: number): FeltRail {
  if (index <= 0) {
    return "south";
  }
  const others = Math.max(count - 1, 0);
  if (others <= 0) {
    return "south";
  }
  if (others === 1) {
    return "north";
  }
  const westN = Math.floor((others + 1) / 3);
  const eastN = Math.floor(others / 3);
  const northN = others - westN - eastN;
  if (index <= westN) {
    return "west";
  }
  if (index <= westN + northN) {
    return "north";
  }
  return "east";
}

export function seatsByRail<T>(seats: T[]): Record<FeltRail, T[]> {
  const north: T[] = [];
  const west: T[] = [];
  const east: T[] = [];
  const south: T[] = [];
  seats.forEach((seat, i) => {
    const rail = feltSeatRail(i, seats.length);
    if (rail === "west") {
      west.push(seat);
    } else if (rail === "north") {
      north.push(seat);
    } else if (rail === "east") {
      east.push(seat);
    } else {
      south.push(seat);
    }
  });
  west.reverse();
  return { north, west, east, south };
}
