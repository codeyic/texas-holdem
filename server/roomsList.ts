/** 大厅展示：仅列出当前有人在线的房间 */

import type { RoomSummary } from "../shared/protocol";
import type { Room } from "./room";

export type { RoomSummary };

export function summarizeOpenRooms(rooms: Map<string, Room>): RoomSummary[] {
  const list: RoomSummary[] = [];
  for (const room of rooms.values()) {
    const online = room.table.players.filter((p) => p.connected);
    if (online.length === 0) {
      continue;
    }
    list.push({
      code: room.code,
      connected: online.length,
      seated: room.table.players.length,
      maxSeats: room.table.maxSeats,
      smallBlind: room.table.smallBlind,
      bigBlind: room.table.bigBlind,
      phase: room.table.phase,
      names: online.map((p) => p.nickname),
    });
  }
  return list.sort((a, b) => a.code.localeCompare(b.code));
}
