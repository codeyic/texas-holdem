/** 局域网德州扑克 HTTP + WebSocket 入口 */

import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { PUBLIC_BASE, publicPageUrl } from "../shared/base";
import { uniqueNickname } from "../shared/nick";
import type { BlindPreset, ClientMsg } from "../shared/protocol";
import { PokerTable } from "./game/table";
import { Room } from "./room";
import { summarizeOpenRooms } from "./roomsList";

const PORT = Number(process.env.PORT || 8080);
const PAGE_PATH = `${PUBLIC_BASE}/`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");

const rooms = new Map<string, Room>();

function listLanUrls(port: number): string[] {
  const urls: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) {
      continue;
    }
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) {
        urls.push(`http://${a.address}:${port}${PUBLIC_BASE}`);
      }
    }
  }
  return urls;
}

/** 邀请链接：公网优先，供二维码与手机加入；局域网仅作同网备用 */
function listInviteUrls(port: number): string[] {
  const publicUrl = publicPageUrl().replace(/\/$/, "");
  const seen = new Set<string>([publicUrl]);
  const urls = [publicUrl];
  for (const u of listLanUrls(port)) {
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function parseBlinds(preset: BlindPreset | undefined): {
  smallBlind: number;
  bigBlind: number;
} {
  if (preset === "5/10") {
    return { smallBlind: 5, bigBlind: 10 };
  }
  if (preset === "25/50") {
    return { smallBlind: 25, bigBlind: 50 };
  }
  return { smallBlind: 10, bigBlind: 20 };
}

function destroyRoom(code: string): void {
  rooms.delete(code);
}

function createRoom(
  nickname: string,
  sessionId: string,
  blinds: BlindPreset | undefined,
): { room: Room; playerId: string } {
  let code = randomCode();
  while (rooms.has(code)) {
    code = randomCode();
  }
  const playerId = randomUUID();
  const { smallBlind, bigBlind } = parseBlinds(blinds);
  const table = new PokerTable({
    hostId: playerId,
    smallBlind,
    bigBlind,
    buyIn: 1000,
  });
  table.addPlayer({ id: playerId, sessionId, nickname, connected: false });
  const room = new Room({
    code,
    table,
    lanUrls: listInviteUrls(PORT),
    onDestroy: destroyRoom,
  });
  rooms.set(code, room);
  return { room, playerId };
}

const app = express();
app.use(cors());
app.use(express.json());

const siteDir = path.resolve(__dirname, "../../codeyc-site");
app.get("/", (_req, res) => {
  res.sendFile(path.join(siteDir, "index.html"));
});
app.use(express.static(siteDir));

app.get(`${PUBLIC_BASE}/api/info`, (_req, res) => {
  res.json({ lanUrls: listInviteUrls(PORT), port: PORT });
});

app.get(`${PUBLIC_BASE}/api/rooms`, (_req, res) => {
  res.json({ rooms: summarizeOpenRooms(rooms) });
});

app.post(`${PUBLIC_BASE}/api/rooms`, (req, res) => {
  const sessionId = String(req.body?.sessionId ?? randomUUID());
  const requested = String(req.body?.nickname ?? "").trim();
  const nickname = uniqueNickname(() => false, requested);
  const blinds = req.body?.blinds as BlindPreset | undefined;
  const { room, playerId } = createRoom(nickname, sessionId, blinds);
  const host = room.table.players.find((p) => p.id === playerId);
  res.json({
    code: room.code,
    sessionId,
    playerId,
    nickname,
    seatCode: host?.seatCode ?? "",
    lanUrls: room.lanUrls,
  });
});

if (process.env.NODE_ENV === "production") {
  app.use(PUBLIC_BASE, express.static(distDir));
  app.use(PUBLIC_BASE, (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
      next();
      return;
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: `${PUBLIC_BASE}/ws` });

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
    const sessionId = String(msg.sessionId ?? "").trim();
    if (!sessionId) {
      ws.send(JSON.stringify({ type: "error", message: "会话无效，请刷新页面重试" }));
      return;
    }
    const nickname = uniqueNickname(
      (n) => room.table.nicknameTaken(n, sessionId),
      msg.nickname,
    );
    const seatCode = String(msg.seatCode ?? "").trim().toUpperCase();
    let player = room.table.pickJoinPlayer(sessionId, seatCode || undefined);
    const isReconnect = Boolean(player);
    const wasConnected = Boolean(player?.connected);
    const claimedBySeat = Boolean(seatCode && room.table.findBySeatCode(seatCode));
    if (player && !claimedBySeat) {
      try {
        room.table.updateNickname(player.id, nickname);
      } catch (err) {
        const message = err instanceof Error ? err.message : "无法加入";
        ws.send(JSON.stringify({ type: "error", message }));
        return;
      }
    } else if (!player) {
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
    if (!player) {
      ws.send(JSON.stringify({ type: "error", message: "无法加入房间" }));
      return;
    }
    extra._data.playerId = player.id;
    extra._data.room = room;
    const firstOnline = room.attachSocket(player.id, ws);
    // 进房 / 断线重连提示（已在线换 socket 不重复刷）
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
      if (playerId !== room.table.hostId) {
        throw new Error("只有房主可以开局");
      }
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
      // 牌局进行中不能离座：保留座位并标离线（与断线一致）
      if (room.table.phase === "betting") {
        room.detachSocket(playerId, ws);
        try {
          ws.close();
        } catch {
          /* 忽略 */
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
      if (playerId !== room.table.hostId) {
        throw new Error("只有房主可以踢人");
      }
      if (msg.playerId === playerId) {
        throw new Error("不能请离自己");
      }
      const kicked = room.table.players.find((p) => p.id === msg.playerId);
      if (!kicked) {
        throw new Error("找不到该玩家");
      }
      const name = kicked.nickname;
      room.broadcastNoticeToConnected(`${name} 被请离`, "kick");
      room.clearOfflineNotice(msg.playerId);
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
      if (playerId !== room.table.hostId) {
        throw new Error("只有房主可以解散");
      }
      room.dissolve();
      return;
    }
    if (msg.type === "chat") {
      room.quickChat(playerId, msg.text);
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "操作失败";
    room.sendError(playerId, message);
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    handleMessage(ws, data.toString());
  });
  ws.on("close", () => {
    const extra = ws as WebSocket & { _data?: SocketData };
    const room = extra._data?.room;
    const playerId = extra._data?.playerId;
    if (room && playerId) {
      room.detachSocket(playerId, ws);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const lans = listLanUrls(PORT);
  console.log(`德州扑克服务已启动：http://127.0.0.1:${PORT}${PAGE_PATH}`);
  for (const u of lans) {
    console.log(`局域网：${u}/`);
  }
});
