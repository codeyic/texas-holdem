/**
 * 真 WebSocket 多用户 churn：进程内起临时 HTTP+WS，不碰 :8080
 */
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { BlindPreset, ClientMsg, ServerMsg } from "../shared/protocol";
import { PokerTable } from "./game/table";
import { Room } from "./room";

const rooms = new Map<string, Room>();

function parseBlinds(preset: BlindPreset | undefined) {
  if (preset === "5/10") return { smallBlind: 5, bigBlind: 10 };
  if (preset === "25/50") return { smallBlind: 25, bigBlind: 50 };
  return { smallBlind: 10, bigBlind: 20 };
}

type SocketData = { playerId?: string; room?: Room };

function handleMessage(ws: WebSocket, raw: string): void {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(raw) as ClientMsg;
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "消息格式错误" }));
    return;
  }
  const extra = ws as WebSocket & { _data?: SocketData };
  extra._data = extra._data ?? {};

  if (msg.type === "join") {
    const room = rooms.get(msg.roomCode.toUpperCase());
    if (!room) {
      ws.send(JSON.stringify({ type: "error", message: "房间不存在" }));
      return;
    }
    const nickname = msg.nickname.trim();
    if (!nickname) {
      ws.send(JSON.stringify({ type: "error", message: "请填写昵称" }));
      return;
    }
    const sessionId = String(msg.sessionId ?? "").trim();
    if (!sessionId) {
      ws.send(JSON.stringify({ type: "error", message: "会话无效，请刷新页面重试" }));
      return;
    }
    let player = room.findBySession(sessionId);
    const isReconnect = Boolean(player);
    const wasConnected = Boolean(player?.connected);
    if (player) {
      try {
        room.table.updateNickname(player.id, nickname);
      } catch (err) {
        const message = err instanceof Error ? err.message : "无法加入";
        ws.send(JSON.stringify({ type: "error", message }));
        return;
      }
    } else {
      try {
        player = room.table.addPlayer({
          id: randomUUID(),
          sessionId,
          nickname,
          connected: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "无法加入";
        ws.send(JSON.stringify({ type: "error", message }));
        return;
      }
    }
    extra._data.playerId = player.id;
    extra._data.room = room;
    const firstOnline = room.attachSocket(player.id, ws);
    if (!isReconnect || firstOnline) {
      room.broadcastNotice(`${player.nickname} 进入房间`, "join");
    } else if (!wasConnected) {
      room.broadcastNotice(`${player.nickname} 重新连接`, "reconnect");
    }
    return;
  }

  const room = extra._data.room;
  const playerId = extra._data.playerId;
  if (!room || !playerId) {
    ws.send(JSON.stringify({ type: "error", message: "请先加入房间" }));
    return;
  }

  try {
    if (msg.type === "start") {
      if (playerId !== room.table.hostId) throw new Error("只有房主可以开局");
      room.startHand();
      return;
    }
    if (msg.type === "action") {
      room.act(playerId, msg.action, msg.raiseTo);
      return;
    }
    if (msg.type === "rebuy") {
      const result = room.table.rebuy(playerId);
      if (result.advanced) {
        room.afterTableChange();
      } else {
        room.broadcast();
      }
      return;
    }
    if (msg.type === "leave") {
      const leaver = room.table.players.find((p) => p.id === playerId);
      const name = leaver?.nickname ?? "玩家";
      if (room.table.phase === "betting") {
        room.detachSocket(playerId, ws);
        try {
          ws.close();
        } catch {
          /* */
        }
        return;
      }
      room.clearOfflineNotice(playerId);
      room.table.removePlayer(playerId);
      room.broadcastNoticeToConnected(`${name} 离开房间`, "leave");
      room.forceDisconnect(playerId);
      room.broadcast();
      return;
    }
    if (msg.type === "kick") {
      if (playerId !== room.table.hostId) throw new Error("只有房主可以踢人");
      const kicked = room.table.players.find((p) => p.id === msg.playerId);
      const name = kicked?.nickname ?? "玩家";
      room.broadcastNoticeToConnected(`${name} 被请离`, "kick");
      room.forceDisconnect(msg.playerId);
      const result = room.table.kickPlayer(msg.playerId);
      if (result.advanced) {
        room.afterTableChange();
      } else {
        room.broadcast();
      }
      return;
    }
    if (msg.type === "dissolve") {
      if (playerId !== room.table.hostId) throw new Error("只有房主可以解散");
      room.dissolve();
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "操作失败";
    room.sendError(playerId, message);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function collect(ws: WebSocket) {
  const msgs: ServerMsg[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as ServerMsg));
  return msgs;
}

function waitMsg(msgs: ServerMsg[], pred: (m: ServerMsg) => boolean, ms = 5000) {
  return new Promise<ServerMsg>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > ms) {
        return reject(new Error(`timeout; last=${JSON.stringify(msgs.slice(-4))}`));
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

function lastState(msgs: ServerMsg[]) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === "state") {
      return m.state;
    }
  }
  return null;
}

async function openJoin(
  wsBase: string,
  roomCode: string,
  nickname: string,
  sessionId: string,
) {
  const ws = new WebSocket(wsBase);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("open timeout")), 5000);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", reject);
  });
  const msgs = collect(ws);
  ws.send(JSON.stringify({ type: "join", roomCode, nickname, sessionId }));
  const msg = await waitMsg(msgs, (m) => m.type === "state" || m.type === "error");
  if (msg.type === "error") {
    ws.close();
    throw Object.assign(new Error(msg.message), { joinError: msg.message });
  }
  if (msg.type !== "state") {
    ws.close();
    throw new Error("进房失败");
  }
  return { ws, msgs, state: msg.state, playerId: msg.state.youPlayerId };
}

describe("WebSocket multi-user churn", () => {
  let port = 0;
  let server: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let wsBase = "";
  let httpBase = "";

  beforeAll(async () => {
    rooms.clear();
    const app = express();
    app.use(express.json());
    app.get("/poker/api/info", (_req, res) => res.json({ ok: true }));
    app.post("/poker/api/rooms", (req, res) => {
      const nickname = String(req.body?.nickname ?? "").trim();
      if (!nickname) {
        res.status(400).json({ error: "请填写昵称" });
        return;
      }
      const sessionId = String(req.body?.sessionId ?? randomUUID());
      const blinds = req.body?.blinds as BlindPreset | undefined;
      let code = "";
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      } while (rooms.has(code));
      const playerId = randomUUID();
      const { smallBlind, bigBlind } = parseBlinds(blinds);
      const table = new PokerTable({ hostId: playerId, smallBlind, bigBlind, buyIn: 1000 });
      table.addPlayer({ id: playerId, sessionId, nickname, connected: false });
      const room = new Room({
        code,
        table,
        lanUrls: ["https://codeyc.top/poker"],
        onDestroy: (c) => rooms.delete(c),
      });
      rooms.set(code, room);
      res.json({ code, sessionId, playerId });
    });

    server = createServer(app);
    wss = new WebSocketServer({ server, path: "/poker/ws" });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => handleMessage(ws, data.toString()));
      ws.on("close", () => {
        const extra = ws as WebSocket & { _data?: SocketData };
        const room = extra._data?.room;
        const playerId = extra._data?.playerId;
        if (room && playerId) room.detachSocket(playerId, ws);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    port = addr.port;
    wsBase = `ws://127.0.0.1:${port}/poker/ws`;
    httpBase = `http://127.0.0.1:${port}/poker`;
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rooms.clear();
  });

  it("enter/leave/disconnect/reconnect/dup nick/late join churn", async () => {
    const createRes = await fetch(`${httpBase}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "房主", blinds: "10/20", sessionId: "sess-host" }),
    });
    const created = await createRes.json();
    expect(createRes.ok).toBe(true);
    const code = created.code as string;

    const host = await openJoin(wsBase, code, "房主", "sess-host");
    await waitMsg(host.msgs, (m) => m.type === "notice" && m.kind === "join");

    const p2 = await openJoin(wsBase, code, "玩家二", "sess-p2");
    const p3 = await openJoin(wsBase, code, "玩家三", "sess-p3");

    let st = lastState(host.msgs)!;
    expect(st.seats).toHaveLength(3);
    expect(st.seats.every((s) => s.connected)).toBe(true);

    await expect(openJoin(wsBase, code, "玩家二", "sess-dup")).rejects.toThrow(/昵称/);

    const p2Id = p2.playerId;
    p2.ws.close();
    await sleep(120);
    st = lastState(host.msgs)!;
    expect(st.seats.find((s) => s.playerId === p2Id)?.connected).toBe(false);
    expect(st.seats).toHaveLength(3);

    await waitMsg(
      host.msgs,
      (m) => m.type === "notice" && m.kind === "offline" && /玩家二/.test(m.text),
      4000,
    );

    const p2b = await openJoin(wsBase, code, "玩家二", "sess-p2");
    st = lastState(host.msgs)!;
    expect(st.seats).toHaveLength(3);
    expect(st.seats.find((s) => s.playerId === p2Id)?.connected).toBe(true);
    expect(p2b.playerId).toBe(p2Id);
    await waitMsg(
      host.msgs,
      (m) => m.type === "notice" && m.kind === "reconnect" && /玩家二/.test(m.text),
      3000,
    );

    host.ws.send(JSON.stringify({ type: "start" }));
    await waitMsg(host.msgs, (m) => m.type === "state" && m.state.phase === "betting");

    const p4 = await openJoin(wsBase, code, "晚到", "sess-p4");
    st = lastState(host.msgs)!;
    expect(st.seats.find((s) => s.playerId === p4.playerId)?.inHand).toBe(false);
    expect(st.phase).toBe("betting");

    const before = st.seats.length;
    p4.ws.send(JSON.stringify({ type: "leave" }));
    await sleep(150);
    st = lastState(host.msgs)!;
    expect(st.seats.length).toBe(before);
    expect(st.seats.find((s) => s.playerId === p4.playerId)?.connected).toBe(false);

    for (let i = 0; i < 8; i++) {
      p3.ws.close();
      await sleep(40);
      const back = await openJoin(wsBase, code, "玩家三", "sess-p3");
      p3.ws = back.ws;
      p3.msgs = back.msgs;
      p3.playerId = back.playerId;
      st = lastState(host.msgs)!;
      const ids = st.seats.map((s) => s.playerId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(st.seats.filter((s) => s.nickname === "玩家三")).toHaveLength(1);
    }

    // 打完一手即可（摊牌后会自动开下一手，不一定回到 idle）
    for (let guard = 0; guard < 80; guard++) {
      st = lastState(host.msgs)!;
      if (st.phase === "idle") {
        break;
      }
      for (const client of [host, p2b, p3]) {
        const s = lastState(client.msgs);
        if (s?.legal) {
          client.ws.send(
            JSON.stringify({
              type: "action",
              action: s.legal.canCheck ? "check" : "fold",
            }),
          );
        }
      }
      if (st.phase === "showdown") {
        await sleep(500);
        break;
      }
      await sleep(30);
    }
    st = lastState(host.msgs)!;
    if (st.phase === "idle") {
      const n = st.seats.length;
      p3.ws.send(JSON.stringify({ type: "leave" }));
      await waitMsg(host.msgs, (m) => m.type === "notice" && m.kind === "leave", 3000);
      st = lastState(host.msgs)!;
      expect(st.seats.length).toBe(n - 1);
    }

    st = lastState(host.msgs)!;
    const nicks = st.seats.map((s) => s.nickname);
    expect(new Set(nicks).size).toBe(nicks.length);

    host.ws.close();
    p2b.ws.close();
    try {
      p3.ws.close();
    } catch {
      /* */
    }
  }, 60_000);
});
