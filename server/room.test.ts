import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { PokerTable } from "./game/table";
import { Room } from "./room";

function makeRoom() {
  const table = new PokerTable({ hostId: "h", smallBlind: 10, bigBlind: 20, buyIn: 1000 });
  table.addPlayer({ id: "h", sessionId: "s-h", nickname: "房主" });
  const room = new Room({
    code: "TEST",
    table,
    lanUrls: [],
    onDestroy: () => {},
  });
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1, OPEN: 1 } as unknown as WebSocket;
  room.attachSocket("h", ws);
  return { room, table, ws };
}

describe("房间 AI 与胜率", () => {
  it("AI 行动由房间调度（模拟计时器）", () => {
    vi.useFakeTimers();
    try {
      const { room, table } = makeRoom();
      table.addAiPlayer("AI-1");
      room.startHand();
      // 2 人局房主为 SB，先跟注推进到 AI（BB）
      room.act("h", "call");
      expect(table.actorId).toBe(table.players.find((p) => p.isAi)!.id);
      vi.advanceTimersByTime(600); // 仅触发 preflop 这一次 AI 行动，避免翻后胜率枚举拖慢测试
      // AI 已被调度行动：log 中出现 AI 的行动记录（非入座日志），牌局继续推进
      expect(table.log.some((l) => /AI-1 (过牌|跟注|弃牌|加注到|全下)/.test(l))).toBe(true);
      vi.useRealTimers();
    } catch (e) {
      vi.useRealTimers();
      throw e;
    }
  });

  it("快照中给自己注入 equity", () => {
    vi.useFakeTimers();
    try {
      const { room, table } = makeRoom();
      table.addPlayer({ id: "p2", sessionId: "s2", nickname: "乙" });
      room.startHand();
      const snap = room.snapshot("h");
      expect(typeof snap.equity).toBe("number");
      vi.useRealTimers();
    } catch (e) {
      vi.useRealTimers();
      throw e;
    }
  });
});

// 说明：Room 构造签名是 { code, table, lanUrls, onDestroy }；
// makeRoom 中房主已是 player，startHand 至少需要 2 名 connected 且有筹码玩家。
