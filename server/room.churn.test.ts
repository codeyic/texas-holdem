/** 多用户进房/断线/重连/离座 churn 测试 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMsg } from "../shared/protocol";
import { PokerTable } from "./game/table";
import { Room } from "./room";

type Msg = ServerMsg;

class MockWs {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWs.OPEN;
  readonly OPEN = MockWs.OPEN;
  messages: Msg[] = [];
  private closeHandlers: Array<() => void> = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as Msg);
  }

  close(): void {
    if (this.readyState === MockWs.CLOSED) {
      return;
    }
    this.readyState = MockWs.CLOSED;
    for (const h of this.closeHandlers) {
      h();
    }
  }

  on(event: string, handler: () => void): void {
    if (event === "close") {
      this.closeHandlers.push(handler);
    }
  }
}

function lastState(ws: MockWs) {
  const states = ws.messages.filter((m) => m.type === "state");
  return states[states.length - 1];
}

function notices(ws: MockWs) {
  return ws.messages.filter((m) => m.type === "notice");
}

function makeRoom() {
  const table = new PokerTable({
    hostId: "host",
    smallBlind: 10,
    bigBlind: 20,
    buyIn: 1000,
  });
  const room = new Room({
    code: "TEST",
    table,
    lanUrls: ["https://codeyc.top/poker"],
    onDestroy: () => undefined,
  });
  return room;
}

describe("Room 连接 churn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("断线后座位保留且 connected=false，重连同一座位并清除离线", () => {
    const room = makeRoom();
    const a = room.table.addPlayer({
      id: "pa",
      sessionId: "sa",
      nickname: "甲",
      connected: false,
    });
    const b = room.table.addPlayer({
      id: "pb",
      sessionId: "sb",
      nickname: "乙",
      connected: false,
    });
    const wsA1 = new MockWs();
    const wsB = new MockWs();
    room.attachSocket(a.id, wsA1 as unknown as import("ws").WebSocket);
    room.attachSocket(b.id, wsB as unknown as import("ws").WebSocket);

    expect(a.connected).toBe(true);
    room.detachSocket(a.id, wsA1 as unknown as import("ws").WebSocket);
    expect(a.connected).toBe(false);
    expect(room.table.players).toHaveLength(2);

    const snap = room.snapshot(b.id);
    const seatA = snap.seats.find((s) => s.playerId === a.id)!;
    expect(seatA.connected).toBe(false);
    expect(seatA.nickname).toBe("甲");

    // 2s 后离线提示
    vi.advanceTimersByTime(2000);
    const offlineNotices = notices(wsB).filter(
      (m) => m.type === "notice" && m.kind === "offline",
    );
    expect(offlineNotices.some((m) => m.type === "notice" && m.text.includes("甲"))).toBe(
      true,
    );

    // 同 session 重连：新 socket，离线徽标清除
    const wsA2 = new MockWs();
    room.attachSocket(a.id, wsA2 as unknown as import("ws").WebSocket);
    expect(a.connected).toBe(true);
    expect(room.table.players.filter((p) => p.sessionId === "sa")).toHaveLength(1);
    const after = room.snapshot(b.id).seats.find((s) => s.playerId === a.id)!;
    expect(after.connected).toBe(true);
  });

  it("快速断线再重连不弹离线提示（防刷屏）", () => {
    const room = makeRoom();
    const a = room.table.addPlayer({
      id: "pa",
      sessionId: "sa",
      nickname: "甲",
    });
    const b = room.table.addPlayer({
      id: "pb",
      sessionId: "sb",
      nickname: "乙",
    });
    const wsB = new MockWs();
    room.attachSocket(b.id, wsB as unknown as import("ws").WebSocket);
    const wsA1 = new MockWs();
    room.attachSocket(a.id, wsA1 as unknown as import("ws").WebSocket);
    wsB.messages = [];

    room.detachSocket(a.id, wsA1 as unknown as import("ws").WebSocket);
    vi.advanceTimersByTime(500);
    const wsA2 = new MockWs();
    room.attachSocket(a.id, wsA2 as unknown as import("ws").WebSocket);
    vi.advanceTimersByTime(3000);

    const offline = notices(wsB).filter(
      (m) => m.type === "notice" && m.kind === "offline",
    );
    expect(offline).toHaveLength(0);
  });

  it("替换 socket 时旧 close 不会把已重连玩家打成离线", () => {
    const room = makeRoom();
    const a = room.table.addPlayer({
      id: "pa",
      sessionId: "sa",
      nickname: "甲",
    });
    const ws1 = new MockWs();
    room.attachSocket(a.id, ws1 as unknown as import("ws").WebSocket);

    // 模拟浏览器换连接：新 attach 会 close 旧 ws；旧 ws close → detach
    const ws2 = new MockWs();
    // 绑定：旧连接 close 时调用 detach（与 server index close handler 一致）
    ws1.on("close", () => {
      room.detachSocket(a.id, ws1 as unknown as import("ws").WebSocket);
    });
    room.attachSocket(a.id, ws2 as unknown as import("ws").WebSocket);
    // attach 内部已 close ws1 → 同步触发 detach
    expect(a.connected).toBe(true);
    expect(room.snapshot(a.id).seats[0].connected).toBe(true);
  });

  it("主动离座移除座位且不残留 ghost", () => {
    const room = makeRoom();
    const a = room.table.addPlayer({
      id: "pa",
      sessionId: "sa",
      nickname: "甲",
    });
    const b = room.table.addPlayer({
      id: "pb",
      sessionId: "sb",
      nickname: "乙",
    });
    const wsA = new MockWs();
    const wsB = new MockWs();
    room.attachSocket(a.id, wsA as unknown as import("ws").WebSocket);
    room.attachSocket(b.id, wsB as unknown as import("ws").WebSocket);
    wsB.messages = [];

    room.clearOfflineNotice(a.id);
    room.table.removePlayer(a.id);
    room.broadcastNoticeToConnected("甲 离开房间", "leave");
    room.forceDisconnect(a.id);
    room.broadcast();

    expect(room.table.players.map((p) => p.id)).toEqual(["pb"]);
    expect(room.snapshot(b.id).seats).toHaveLength(1);
    expect(
      notices(wsB).some((m) => m.type === "notice" && m.kind === "leave"),
    ).toBe(true);
  });

  it("重复昵称被拒绝；同 session 可改名回原位", () => {
    const room = makeRoom();
    room.table.addPlayer({ id: "pa", sessionId: "sa", nickname: "甲" });
    room.table.addPlayer({ id: "pb", sessionId: "sb", nickname: "乙" });
    expect(() =>
      room.table.addPlayer({ id: "pc", sessionId: "sc", nickname: "甲" }),
    ).toThrow(/昵称已被使用/);
    expect(() =>
      room.table.addPlayer({ id: "pc", sessionId: "sc", nickname: "甲" }),
    ).toThrow();
    // 同 session 重连改名
    room.table.updateNickname("pb", "丙");
    expect(room.table.players.find((p) => p.id === "pb")?.nickname).toBe("丙");
    expect(() => room.table.updateNickname("pb", "甲")).toThrow(/昵称已被使用/);
  });

  it("中途入座旁观，下一手参战；断线不减少人数", () => {
    const room = makeRoom();
    const a = room.table.addPlayer({ id: "pa", sessionId: "sa", nickname: "甲" });
    const b = room.table.addPlayer({ id: "pb", sessionId: "sb", nickname: "乙" });
    room.startHand();
    expect(room.table.phase).toBe("betting");

    const c = room.table.addPlayer({ id: "pc", sessionId: "sc", nickname: "丙" });
    expect(c.inHand).toBe(false);
    expect(room.table.players).toHaveLength(3);

    const wsC = new MockWs();
    room.attachSocket(c.id, wsC as unknown as import("ws").WebSocket);
    room.detachSocket(c.id, wsC as unknown as import("ws").WebSocket);
    expect(c.connected).toBe(false);
    expect(room.table.players).toHaveLength(3);
    // 旁观离线可立刻请离
    room.table.kickPlayer(c.id);
    expect(room.table.players).toHaveLength(2);
    // 正在打的人不能直接 remove
    expect(() => room.table.removePlayer(a.id)).toThrow(/不能直接离座/);
    a.connected = false;
    room.table.kickPlayer(a.id);
    expect(a.pendingKick).toBe(true);
    expect(a.folded).toBe(true);
  });

  it("频繁进出：离座后再同昵称新 session 可进；旧 session 重连不新建", () => {
    const room = makeRoom();
    const a = room.table.addPlayer({ id: "pa", sessionId: "sa", nickname: "甲" });
    room.table.addPlayer({ id: "pb", sessionId: "sb", nickname: "乙" });
    const wsA = new MockWs();
    room.attachSocket(a.id, wsA as unknown as import("ws").WebSocket);

    room.table.removePlayer(a.id);
    room.forceDisconnect(a.id);
    expect(room.findBySession("sa")).toBeUndefined();

    // 新 session 用同昵称
    const a2 = room.table.addPlayer({
      id: "pa2",
      sessionId: "sa2",
      nickname: "甲",
    });
    expect(a2.seat).toBeDefined();
    expect(room.table.players.filter((p) => p.nickname === "甲")).toHaveLength(1);

    // 旧 session 找不到 → 不会幽灵占座
    expect(room.findBySession("sa")).toBeUndefined();
    // 新 session 重连
    const found = room.findBySession("sa2");
    expect(found?.id).toBe("pa2");
    const ws2 = new MockWs();
    const ws3 = new MockWs();
    room.attachSocket(found!.id, ws2 as unknown as import("ws").WebSocket);
    room.detachSocket(found!.id, ws2 as unknown as import("ws").WebSocket);
    room.attachSocket(found!.id, ws3 as unknown as import("ws").WebSocket);
    expect(room.table.players.filter((p) => p.sessionId === "sa2")).toHaveLength(1);
    expect(found!.connected).toBe(true);
  });

  it("快捷聊天只允许白名单且有冷却", () => {
    const room = makeRoom();
    const a = room.table.addPlayer({
      id: "pa",
      sessionId: "sa",
      nickname: "甲",
      connected: false,
    });
    const b = room.table.addPlayer({
      id: "pb",
      sessionId: "sb",
      nickname: "乙",
      connected: false,
    });
    const wa = new MockWs();
    const wb = new MockWs();
    room.attachSocket(a.id, wa as unknown as import("ws").WebSocket);
    room.attachSocket(b.id, wb as unknown as import("ws").WebSocket);
    wa.messages.length = 0;
    wb.messages.length = 0;
    room.quickChat(a.id, "快点啊……");
    const chats = wa.messages.filter((m) => m.type === "chat");
    expect(chats).toHaveLength(1);
    if (chats[0].type === "chat") {
      expect(chats[0].text).toBe("快点啊……");
      expect(chats[0].playerId).toBe(a.id);
    }
    expect(wb.messages.some((m) => m.type === "chat")).toBe(true);
    expect(() => room.quickChat(a.id, "快点啊……")).toThrow("说太快了");
    expect(() => room.quickChat(a.id, "随便打字")).toThrow("不能发送这条用语");
    vi.advanceTimersByTime(1600);
    room.quickChat(a.id, "我有事先走了");
    expect(wa.messages.filter((m) => m.type === "chat")).toHaveLength(2);
  });

  it("首次 attach（房主建房后）应视为 firstOnline", () => {
    const room = makeRoom();
    const host = room.table.addPlayer({
      id: "host",
      sessionId: "sh",
      nickname: "房主",
      connected: false,
    });
    const ws = new MockWs();
    const first = room.attachSocket(host.id, ws as unknown as import("ws").WebSocket);
    expect(first).toBe(true);
    const second = room.attachSocket(host.id, new MockWs() as unknown as import("ws").WebSocket);
    expect(second).toBe(false);
  });
});

describe("Room 状态快照字段", () => {
  it("snapshot 含 connected 供 UI 离线徽标", () => {
    const room = makeRoom();
    const a = room.table.addPlayer({ id: "pa", sessionId: "sa", nickname: "甲" });
    a.connected = false;
    const seat = room.snapshot(null).seats[0];
    expect(seat.connected).toBe(false);
  });
});

// silence unused
void lastState;
