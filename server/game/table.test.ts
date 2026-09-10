import { describe, expect, it } from "vitest";
import { makeDeck, parseCards, type Card } from "./cards";
import { PokerTable } from "./table";

function seat(table: PokerTable, id: string, name: string) {
  return table.addPlayer({ id, sessionId: id, nickname: name });
}

/** 牌堆从末尾弹出，因此数组最后一张会先发 */
function deckFromDealOrder(firstDealt: Card[]): Card[] {
  return [...firstDealt].reverse();
}

describe("牌局引擎", () => {
  it("拒绝小于最低加注的加注", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    seat(t, "b", "乙");
    t.startHand();
    const actor = t.actorId!;
    expect(() => t.applyAction(actor, "raise", 25)).toThrow(/加注至少/);
  });

  it("全员弃牌后底池给最后一人", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    seat(t, "b", "乙");
    t.startHand();
    const first = t.actorId!;
    t.applyAction(first, "fold");
    expect(t.phase).toBe("showdown");
    expect(t.winners).toHaveLength(1);
    expect(t.winners[0].playerId).not.toBe(first);
    expect(t.winners[0].amount).toBe(30);
  });

  it("摊牌时边池只在有资格的人之间分配", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 100,
    });
    const a = seat(t, "a", "甲");
    const b = seat(t, "b", "乙");
    const c = seat(t, "c", "丙");
    a.chips = 50;
    b.chips = 100;
    c.chips = 100;

    const holesAndBoard: Card[] = [];
    holesAndBoard.push(
      ...parseCards([
        "Ah",
        "Kh",
        "2c",
        "2d",
        "3c",
        "3d",
        "9s",
        "8s",
        "7s",
        "6s",
        "5d",
      ]),
    );
    const rest = makeDeck().filter(
      (card) =>
        !holesAndBoard.some((x) => x.r === card.r && x.s === card.s),
    );
    t.startHand(deckFromDealOrder([...holesAndBoard, ...rest]));

    while (t.phase === "betting" && t.actorId) {
      t.applyAction(t.actorId, "allin");
    }
    expect(t.phase).toBe("showdown");
    const total = t.winners.reduce((s, w) => s + w.amount, 0);
    expect(total).toBe(250);
    const aWon = t.winners.find((w) => w.playerId === "a")?.amount ?? 0;
    expect(aWon).toBeLessThanOrEqual(150);
  });

  it("拒绝房间内重复昵称（不同 session）", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    t.addPlayer({ id: "a", sessionId: "s1", nickname: "Alice" });
    expect(() =>
      t.addPlayer({ id: "b", sessionId: "s2", nickname: "alice" }),
    ).toThrow(/昵称已被使用/);
  });

  it("同一 session 改名不与自己冲突", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    t.addPlayer({ id: "a", sessionId: "s1", nickname: "Alice" });
    t.updateNickname("a", "Alice");
    t.updateNickname("a", "Alicia");
    expect(t.players[0].nickname).toBe("Alicia");
  });

  it("牌局进行中可晚加入，本手旁观下一手参战", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    seat(t, "b", "乙");
    t.startHand();
    expect(t.phase).toBe("betting");
    const late = t.addPlayer({
      id: "c",
      sessionId: "s3",
      nickname: "丙",
      connected: true,
    });
    expect(late.inHand).toBe(false);
    expect(late.chips).toBe(1000);
    // 结束当前手
    const first = t.actorId!;
    t.applyAction(first, "fold");
    expect(t.phase).toBe("showdown");
    t.finishShowdownToIdle();
    t.startHand();
    const c = t.players.find((p) => p.id === "c")!;
    expect(c.inHand).toBe(true);
    expect(c.holeCards).toHaveLength(2);
  });

  it("牌局中请离在打的人：先弃牌，摊牌后离座", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    seat(t, "b", "乙");
    t.startHand();
    const victim = t.players.find((p) => p.id !== t.actorId)!;
    t.kickPlayer(victim.id);
    expect(victim.folded).toBe(true);
    expect(victim.pendingKick).toBe(true);
    expect(t.players.some((p) => p.id === victim.id)).toBe(true);
    t.finishShowdownToIdle();
    expect(t.players.some((p) => p.id === victim.id)).toBe(false);
  });

  it("离线玩家不会被带进下一手", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    const b = seat(t, "b", "乙");
    const c = seat(t, "c", "丙");
    c.connected = false;
    t.startHand();
    expect(c.inHand).toBe(false);
    expect(b.inHand).toBe(true);
  });

  it("座位码可换 session 认回原座", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    const a = seat(t, "a", "甲");
    expect(a.seatCode).toMatch(/^[A-Z0-9]{4}$/);
    const claimed = t.claimBySeatCode(a.seatCode, "new-phone");
    expect(claimed.id).toBe(a.id);
    expect(claimed.sessionId).toBe("new-phone");
    expect(claimed.prevSessionId).toBe("a");
    expect(() => t.claimBySeatCode("ZZZZ", "x")).toThrow(/座位码无效/);
  });

  it("过期座位码不阻断进房：忽略后按 session 认回", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    const a = seat(t, "sess-a", "甲");
    expect(t.pickJoinPlayer("sess-a", "ZZZZ")?.id).toBe(a.id);
    const stale = a.seatCode;
    t.removePlayer(a.id);
    expect(t.pickJoinPlayer("sess-a", stale)).toBeUndefined();
    const b = seat(t, "sess-b", "乙");
    expect(t.pickJoinPlayer("new-phone", b.seatCode)?.id).toBe(b.id);
    expect(t.pickJoinPlayer("new-phone", b.seatCode)?.sessionId).toBe("new-phone");
  });

  it("入座算拿1手，没筹码时牌局中也能再拿一手", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    const a = seat(t, "a", "甲");
    const b = seat(t, "b", "乙");
    expect(a.buyIns).toBe(1);
    expect(b.buyIns).toBe(1);
    a.chips = 0;
    t.rebuy("a");
    expect(a.chips).toBe(1000);
    expect(a.buyIns).toBe(2);
    t.startHand();
    a.chips = 0;
    a.allIn = true;
    t.rebuy("a");
    expect(a.chips).toBe(1000);
    expect(a.buyIns).toBe(3);
    expect(a.allIn).toBe(true);
    expect(a.hasActed).toBe(true);
    expect(a.rebuyLocked).toBe(true);
  });

  it("轮到自己再拿筹码后牌局继续，不会卡死", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    seat(t, "b", "乙");
    t.startHand();
    const actorId = t.actorId!;
    const actor = t.players.find((p) => p.id === actorId)!;
    actor.chips = 0;
    t.rebuy(actorId);
    expect(actor.rebuyLocked).toBe(true);
    expect(t.legalActions(actorId)).toBeNull();
    expect(t.actorId === actorId && t.phase === "betting").toBe(false);
  });

  it("被请离后按原 session 认回原座，不新开座位", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    const b = seat(t, "b", "乙");
    t.startHand();
    t.kickPlayer(b.id);
    expect(b.pendingKick).toBe(true);
    expect(t.pickJoinPlayer(b.sessionId)?.id).toBe(b.id);
    expect(t.pickJoinPlayer("phone", b.seatCode)?.id).toBe(b.id);
    expect(t.players).toHaveLength(2);
  });
});
