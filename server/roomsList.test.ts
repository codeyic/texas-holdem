import { describe, expect, it } from "vitest";
import { randomNickname, uniqueNickname } from "../shared/nick";
import { Room } from "./room";
import { PokerTable } from "./game/table";
import { summarizeOpenRooms } from "./roomsList";

describe("随机昵称与房间列表", () => {
  it("随机昵称非空且不太长", () => {
    const name = randomNickname(() => 0.2);
    expect(name.length).toBeGreaterThan(2);
    expect(name.length).toBeLessThanOrEqual(12);
  });

  it("有人在线才出现在列表，全离线则隐藏", () => {
    const rooms = new Map<string, Room>();
    const table = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    const p = table.addPlayer({
      id: "a",
      sessionId: "sa",
      nickname: "甲",
      connected: true,
    });
    const room = new Room({
      code: "ABCD",
      table,
      lanUrls: [],
      onDestroy: () => undefined,
    });
    rooms.set("ABCD", room);
    expect(summarizeOpenRooms(rooms)).toHaveLength(1);
    expect(summarizeOpenRooms(rooms)[0].names).toEqual(["甲"]);
    p.connected = false;
    expect(summarizeOpenRooms(rooms)).toHaveLength(0);
  });

  it("已被占用的昵称会换成另一个", () => {
    const name = uniqueNickname((n) => n.startsWith("快乐"), "", () => 0);
    expect(name.startsWith("快乐")).toBe(false);
  });
});
