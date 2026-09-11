/** 房间：会话重连、倒计时、把牌桌状态推给每个玩家 */

import type { WebSocket } from "ws";
import type {
  CardDto,
  ClientAction,
  DecisionPoint,
  HandRecord,
  LegalActionsDto,
  NoticeKind,
  PublicState,
} from "../shared/protocol";
import type { Card } from "./game/cards";
import { PokerTable } from "./game/table";
import { isQuickChatLine } from "../shared/quickChat";
import { chooseAiAction, profileByNickname } from "./engine/ai";
import { winEquity } from "./engine/equity";
import { actionEv, classifyLeaks, recommendAction } from "./engine/review";

const ACTION_MS = 20_000;
const SHOWDOWN_MS = 6_000;
const AI_DELAY_MS = 600;
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
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private handId: string | null = null;
  private handDecisions = new Map<string, DecisionPoint[]>(); // playerId -> 本手决策
  private handHeroes = new Map<string, { nickname: string; hole: Card[] }>();
  private handOutcome: HandRecord["outcome"] | null = null;
  /** 胜率缓存：同一街内手牌/公共牌/对手数不变则不重复采样 */
  private equityCache = new Map<string, number>();
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
    let equity: number | null = null;
    if (youPlayerId && this.table.phase === "betting" && this.table.potTotal() > 0) {
      equity = this.equityFor(youPlayerId);
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
      actorId: this.table.actorId,
      actionDeadline: this.actionDeadline,
      youPlayerId: youPlayerId,
      yourCards: you?.holeCards ? you.holeCards.map(cardDto) : null,
      equity,
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
          isAi: p.isAi,
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

  /** 初始化本手复盘上下文（room.startHand 与 showdown 自动续局共用） */
  private beginHand(): void {
    this.handId = `hand-${this.code}-${Date.now()}`;
    this.handDecisions = new Map();
    this.handHeroes = new Map();
    this.handOutcome = null;
    this.equityCache.clear();
    for (const p of this.table.players) {
      if (!p.isAi && p.inHand && p.holeCards) {
        this.handHeroes.set(p.id, { nickname: p.nickname, hole: p.holeCards });
      }
    }
  }

  startHand(): void {
    this.clearTimers();
    this.table.startHand();
    this.beginHand();
    this.armActionTimer();
    this.scheduleAiIfNeeded();
    this.broadcast();
  }

  act(playerId: string, action: ClientAction, raiseTo?: number): void {
    const p = this.table.players.find((x) => x.id === playerId);
    const actor = this.table.actorId === playerId && p;
    if (actor && !p.isAi && p.holeCards) {
      this.recordDecision(playerId, action, raiseTo);
    }
    this.table.applyAction(playerId, action, raiseTo);
    this.afterTableChange();
  }

  afterTableChange(): void {
    this.clearActionTimer();
    if (this.table.phase === "showdown") {
      this.actionDeadline = null;
      this.finalizeHandRecords(); // 摊牌后立即结算复盘
      this.broadcast();
      this.showdownTimer = setTimeout(() => {
        this.table.finishShowdownToIdle();
        const withChips = this.table.players.filter(
          (p) => p.chips > 0 && p.connected,
        );
        if (withChips.length >= 2) {
          this.table.startHand();
          this.beginHand(); // 续局也要初始化复盘上下文
          this.armActionTimer();
          this.scheduleAiIfNeeded();
        }
        this.broadcast();
      }, SHOWDOWN_MS);
      return;
    }
    if (this.table.phase === "betting") {
      this.armActionTimer();
      this.scheduleAiIfNeeded();
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

  /** 当前决策状态下的实时胜率；同一街内（手牌/公共牌/对手数不变）复用缓存避免每次广播重复采样 */
  private equityFor(playerId: string): number | null {
    const p = this.table.players.find((x) => x.id === playerId);
    if (!p?.holeCards || p.isAi || this.table.phase !== "betting") {
      return null;
    }
    const opponents = this.table.players.filter(
      (o) => o.inHand && !o.folded && o.id !== playerId,
    ).length;
    const key = [
      this.table.street ?? "",
      this.table.community.map((c) => c.r + c.s).join(""),
      p.holeCards.map((c) => c.r + c.s).join(""),
      opponents,
    ].join("|");
    const cached = this.equityCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = winEquity({
      heroCards: p.holeCards,
      community: this.table.community,
      opponents: Array.from(
        { length: Math.max(1, opponents) },
        () => "random" as const,
      ),
      iterations: this.table.community.length >= 3 ? 20 : 300,
    }).win;
    this.equityCache.set(key, value);
    return value;
  }

  /** 采集真人玩家一次决策，生成 DecisionPoint 存入本手复盘 */
  private recordDecision(
    playerId: string,
    actualAction: ClientAction,
    raiseTo?: number,
  ): void {
    const p = this.table.players.find((x) => x.id === playerId);
    if (!p || !p.holeCards || this.table.phase !== "betting") {
      return;
    }
    const toCall = Math.max(0, this.table.currentBet - p.betThisStreet);
    const pot = this.table.potTotal();
    const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;
    const equity = this.equityFor(playerId);
    if (equity === null) {
      return;
    }
    const canCheck = toCall === 0;
    const legal = this.table.legalActions(playerId);
    const minRaiseTo = legal?.minRaiseTo ?? this.table.minRaise;
    const maxRaiseTo = legal?.maxRaiseTo ?? p.betThisStreet + p.chips;
    const rec = recommendAction({
      winEquity: equity,
      pot,
      toCall,
      canCheck,
      minRaiseTo,
      maxRaiseTo,
      chips: p.chips,
    });
    // evGap = 实际动作 EV - 推荐动作 EV（负 = 犯错）；lostBB 正数 = 犯错损失 BB
    const actualEv = actionEv(actualAction, equity, pot, toCall);
    const recommendedEv = actionEv(rec.action, equity, pot, toCall);
    const evGap = actualEv - recommendedEv;
    const dp: DecisionPoint = {
      street: this.table.street ?? "preflop",
      position: this.positionOf(p),
      pot,
      toCall,
      winEquity: equity,
      potOdds,
      actualAction,
      raiseTo,
      recommendedAction: rec.action,
      evGap,
      lostBB: -evGap / this.table.bigBlind,
      leakTags: classifyLeaks({
        actualAction,
        recommendedAction: rec.action,
        winEquity: equity,
        pot,
        toCall,
      }),
    };
    const list = this.handDecisions.get(playerId) ?? [];
    list.push(dp);
    this.handDecisions.set(playerId, list);
  }

  /** 简化位置判定：按座位相对庄位的顺序 */
  private positionOf(p: { seat: number }): string {
    const seated = [...this.table.players].sort((a, b) => a.seat - b.seat);
    const idx = seated.findIndex((x) => x.seat === p.seat);
    const n = seated.length;
    const dealerIdx = seated.findIndex((x) => x.seat === this.table.dealerSeat);
    const rel = (idx - dealerIdx + n) % n; // 0=庄位
    if (n === 2) {
      return rel === 0 ? "BTN" : "BB";
    }
    if (rel === 0) {
      return "BTN";
    }
    if (rel === 1) {
      return "SB";
    }
    if (rel === 2) {
      return "BB";
    }
    if (rel === n - 1) {
      return "CO";
    }
    if (rel === n - 2) {
      return "MP";
    }
    return "UTG";
  }

  private scheduleAiIfNeeded(): void {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    if (this.table.phase !== "betting") {
      return;
    }
    const actorId = this.table.actorId;
    if (!actorId) {
      return;
    }
    const actor = this.table.players.find((p) => p.id === actorId);
    if (!actor?.isAi) {
      return;
    }
    this.aiTimer = setTimeout(() => this.aiAct(), AI_DELAY_MS);
  }

  private aiAct(): void {
    this.aiTimer = null;
    const actorId = this.table.actorId;
    if (!actorId || this.table.phase !== "betting") {
      return;
    }
    const actor = this.table.players.find((p) => p.id === actorId);
    if (!actor?.isAi || !actor.holeCards) {
      return;
    }
    const legal = this.table.legalActions(actorId);
    if (!legal) {
      return;
    }
    const toCall = Math.max(0, this.table.currentBet - actor.betThisStreet);
    const opponents = this.table.players.filter(
      (o) => o.inHand && !o.folded && o.id !== actorId,
    ).length;
    const choice = chooseAiAction({
      hole: actor.holeCards,
      community: this.table.community,
      profile: profileByNickname(actor.nickname),
      pot: this.table.potTotal(),
      toCall,
      minRaiseTo: legal.minRaiseTo,
      maxRaiseTo: legal.maxRaiseTo,
      chips: actor.chips,
      canCheck: legal.canCheck,
      opponents,
    });
    try {
      this.table.applyAction(actorId, choice.action, choice.raiseTo);
      this.afterTableChange();
    } catch (err) {
      // AI 行动失败走超时兜底
      this.autoAct();
    }
  }

  /** 摊牌后为每个有决策记录的真人玩家生成 HandRecord 并推送 review */
  private finalizeHandRecords(): void {
    if (!this.handId) {
      return;
    }
    for (const [playerId, hero] of this.handHeroes) {
      const decisions = this.handDecisions.get(playerId) ?? [];
      if (decisions.length === 0) {
        continue;
      }
      const win = this.table.winners.find((w) => w.playerId === playerId);
      const record: HandRecord = {
        handId: this.handId,
        startedAt: Number(this.handId.split("-").pop() ?? 0),
        smallBlind: this.table.smallBlind,
        bigBlind: this.table.bigBlind,
        heroNickname: hero.nickname,
        heroHole: hero.hole.map((c) => ({ r: c.r, s: c.s })),
        decisions,
        outcome: {
          wonChips: win?.amount ?? 0,
          place: win ? 1 : 2,
          finalHand: win?.handName ?? "",
        },
      };
      this.send(playerId, { type: "review", record });
    }
    this.handId = null;
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
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    if (this.showdownTimer) {
      clearTimeout(this.showdownTimer);
      this.showdownTimer = null;
    }
  }
}
