/** 房间：会话重连、倒计时、把牌桌状态推给每个玩家 */

import type { WebSocket } from "ws";
import type { CardDto, LegalActionsDto, NoticeKind, PublicState } from "../shared/protocol";
import type { Card } from "./game/cards";
import { PokerTable } from "./game/table";
import { isQuickChatLine } from "../shared/quickChat";

const ACTION_MS = 20_000;
const SHOWDOWN_MS = 6_000;
/** 短暂断线（刷新/重连）不立刻弹「离线」，避免与「重连」叠刷 */
const OFFLINE_NOTICE_MS = 2_000;
const CHAT_COOLDOWN_MS = 1_500;

function cardDto(c: Card): CardDto {
  return { r: c.r, s: c.s };
}

export class Room {
  readonly code: string;
  readonly table: PokerTable;
  lanUrls: string[] = [];
  actionDeadline: number | null = null;
  private sockets = new Map<string, WebSocket>();
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private showdownTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 曾成功上线过的玩家（用于区分房主 API 建房后首次进房 vs 断线重连） */
  private everOnline = new Set<string>();
  private lastChatAt = new Map<string, number>();
  private onDestroy: (code: string) => void;

  constructor(opts: {
    code: string;
    table: PokerTable;
    lanUrls: string[];
    onDestroy: (code: string) => void;
  }) {
    this.code = opts.code;
    this.table = opts.table;
    this.lanUrls = opts.lanUrls;
    this.onDestroy = opts.onDestroy;
  }

  /** @returns 是否为该玩家首次连上（含房主建房后第一次 WS） */
  attachSocket(playerId: string, ws: WebSocket): boolean {
    this.clearOfflineNotice(playerId);
    const prev = this.sockets.get(playerId);
    // 先挂上新 socket，再关旧连接，避免 close 同步触发 detach 误标离线
    this.sockets.set(playerId, ws);
    const p = this.table.players.find((x) => x.id === playerId);
    if (p) {
      p.connected = true;
    }
    const firstOnline = !this.everOnline.has(playerId);
    this.everOnline.add(playerId);
    if (prev && prev !== ws) {
      try {
        prev.close();
      } catch {
        /* 忽略 */
      }
    }
    this.broadcast();
    return firstOnline;
  }

  detachSocket(playerId: string, ws: WebSocket): void {
    if (this.sockets.get(playerId) === ws) {
      this.sockets.delete(playerId);
      const p = this.table.players.find((x) => x.id === playerId);
      if (p) {
        p.connected = false;
        this.scheduleOfflineNotice(playerId, p.nickname);
      }
      this.broadcast();
      if (this.sockets.size === 0 && this.table.phase === "idle") {
        setTimeout(() => {
          if (this.sockets.size === 0) {
            this.onDestroy(this.code);
          }
        }, 30 * 60 * 1000);
      }
    }
  }

  /** 主动离开/踢人后不再弹离线提示 */
  clearOfflineNotice(playerId: string): void {
    const t = this.offlineNoticeTimers.get(playerId);
    if (t) {
      clearTimeout(t);
      this.offlineNoticeTimers.delete(playerId);
    }
  }

  /** 踢人：关掉对方 socket，不触发离线提示 */
  forceDisconnect(playerId: string): void {
    this.clearOfflineNotice(playerId);
    this.everOnline.delete(playerId);
    const ws = this.sockets.get(playerId);
    this.sockets.delete(playerId);
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    }
  }

  private scheduleOfflineNotice(playerId: string, nickname: string): void {
    this.clearOfflineNotice(playerId);
    const timer = setTimeout(() => {
      this.offlineNoticeTimers.delete(playerId);
      const p = this.table.players.find((x) => x.id === playerId);
      if (p && !p.connected) {
        this.broadcastNotice(`${nickname} 离线`, "offline");
      }
    }, OFFLINE_NOTICE_MS);
    this.offlineNoticeTimers.set(playerId, timer);
  }

  findBySession(sessionId: string) {
    return this.table.players.find(
      (p) => p.sessionId === sessionId || p.prevSessionId === sessionId,
    );
  }

  snapshot(youPlayerId: string | null): PublicState {
    const you = this.table.players.find((p) => p.id === youPlayerId);
    const reveal = this.table.phase === "showdown";
    let legal: LegalActionsDto | null = null;
    if (youPlayerId) {
      legal = this.table.legalActions(youPlayerId);
    }
    return {
      roomCode: this.code,
      phase: this.table.phase,
      street: this.table.street,
      smallBlind: this.table.smallBlind,
      bigBlind: this.table.bigBlind,
      buyIn: this.table.buyIn,
      community: this.table.community.map(cardDto),
      pot: this.table.potTotal(),
      currentBet: this.table.currentBet,
      equity: null, // TODO(Task 2): 注入实时胜率
      actorId: this.table.actorId,
      actionDeadline: this.actionDeadline,
      youPlayerId: youPlayerId,
      yourCards: you?.holeCards ? you.holeCards.map(cardDto) : null,
      legal,
      seats: this.table.players.map((p) => {
        const showOwn = p.id === youPlayerId && p.holeCards;
        const showSd = reveal && p.holeCards && p.inHand && !p.folded;
        let hole: CardDto[] | null = null;
        if (showOwn || showSd) {
          hole = p.holeCards!.map(cardDto);
        }
        return {
          playerId: p.id,
          nickname: p.nickname,
          seat: p.seat,
          chips: p.chips,
          betThisStreet: p.betThisStreet,
          folded: p.folded,
          allIn: p.allIn,
          inHand: p.inHand,
          connected: p.connected,
          isHost: p.id === this.table.hostId,
          isDealer: p.seat === this.table.dealerSeat && this.table.phase !== "idle",
          isActor: p.id === this.table.actorId,
          isAi: false, // TODO(Task 2): 从 TablePlayer 读取 AI 标识
          holeCards: hole,
          buyIns: p.buyIns,
          seatCode: p.seatCode,
        };
      }),
      winners: this.table.winners,
      log: this.table.log.slice(-12),
      hostId: this.table.hostId,
      lanUrls: this.lanUrls,
    };
  }

  send(playerId: string, payload: unknown): void {
    const ws = this.sockets.get(playerId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  sendError(playerId: string, message: string): void {
    this.send(playerId, { type: "error", message });
  }

  broadcast(): void {
    for (const p of this.table.players) {
      this.send(p.id, { type: "state", state: this.snapshot(p.id) });
    }
  }

  /** 房间内全局提示（进房/离开/离线/重连等） */
  broadcastNotice(text: string, kind: NoticeKind): void {
    const payload = { type: "notice", text, kind };
    for (const p of this.table.players) {
      this.send(p.id, payload);
    }
  }

  /** 发给仍连着的人（含即将被踢的人） */
  broadcastNoticeToConnected(text: string, kind: NoticeKind): void {
    const payload = { type: "notice", text, kind };
    for (const [playerId] of this.sockets) {
      this.send(playerId, payload);
    }
  }

  quickChat(playerId: string, text: string): void {
    if (!isQuickChatLine(text)) {
      throw new Error("不能发送这条用语");
    }
    const speaker = this.table.players.find((p) => p.id === playerId);
    if (!speaker) {
      throw new Error("找不到该玩家");
    }
    const now = Date.now();
    const last = this.lastChatAt.get(playerId) ?? 0;
    if (now - last < CHAT_COOLDOWN_MS) {
      throw new Error("说太快了");
    }
    this.lastChatAt.set(playerId, now);
    const payload = {
      type: "chat",
      playerId,
      nickname: speaker.nickname,
      text,
    };
    for (const p of this.table.players) {
      this.send(p.id, payload);
    }
  }

  startHand(): void {
    this.clearTimers();
    this.table.startHand();
    this.armActionTimer();
    this.broadcast();
  }

  act(
    playerId: string,
    action: "fold" | "check" | "call" | "raise" | "allin",
    raiseTo?: number,
  ): void {
    this.table.applyAction(playerId, action, raiseTo);
    this.afterTableChange();
  }

  afterTableChange(): void {
    this.clearActionTimer();
    if (this.table.phase === "showdown") {
      this.actionDeadline = null;
      this.broadcast();
      this.showdownTimer = setTimeout(() => {
        this.table.finishShowdownToIdle();
        const withChips = this.table.players.filter(
          (p) => p.chips > 0 && p.connected,
        );
        if (withChips.length >= 2) {
          this.table.startHand();
          this.armActionTimer();
        }
        this.broadcast();
      }, SHOWDOWN_MS);
      return;
    }
    if (this.table.phase === "betting") {
      this.armActionTimer();
    }
    this.broadcast();
  }

  autoAct(): void {
    const id = this.table.actorId;
    if (!id) {
      return;
    }
    const legal = this.table.legalActions(id);
    if (!legal) {
      return;
    }
    try {
      if (legal.canCheck) {
        this.table.applyAction(id, "check");
      } else {
        this.table.applyAction(id, "fold");
      }
      this.afterTableChange();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "超时行动失败";
      this.sendError(id, msg);
    }
  }

  dissolve(): void {
    this.clearTimers();
    for (const t of this.offlineNoticeTimers.values()) {
      clearTimeout(t);
    }
    this.offlineNoticeTimers.clear();
    this.everOnline.clear();
    for (const ws of this.sockets.values()) {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    }
    this.sockets.clear();
    this.onDestroy(this.code);
  }

  private armActionTimer(): void {
    this.clearActionTimer();
    if (this.table.phase !== "betting" || !this.table.actorId) {
      this.actionDeadline = null;
      return;
    }
    this.actionDeadline = Date.now() + ACTION_MS;
    this.actionTimer = setTimeout(() => this.autoAct(), ACTION_MS);
  }

  private clearActionTimer(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearActionTimer();
    if (this.showdownTimer) {
      clearTimeout(this.showdownTimer);
      this.showdownTimer = null;
    }
  }
}
