/** 无限注德州扑克桌：发牌、盲注、下注与摊牌 */

import type { LegalActionsDto } from "../../shared/protocol";
import { makeDeck, shuffle, type Card } from "./cards";
import { bestHand, compareValue, handName } from "./evaluate";
import { buildPots } from "./pots";

export interface TablePlayer {
  id: string;
  sessionId: string;
  nickname: string;
  seat: number;
  chips: number;
  holeCards: Card[] | null;
  folded: boolean;
  allIn: boolean;
  betThisStreet: number;
  contrib: number;
  hasActed: boolean;
  inHand: boolean;
  connected: boolean;
  /** 牌局中被请离：本手先弃牌，手牌结束后再离座 */
  pendingKick: boolean;
  /** 买入次数：入座 1，输光再拿筹码 +1 */
  buyIns: number;
  /** 本手牌中途再拿的筹码，本手不能再用来下注 */
  rebuyLocked: boolean;
  seatCode: string;
  prevSessionId: string | null;
  /** AI 玩家：由 addAiPlayer 加入，无真实 socket */
  isAi: boolean;
}

export type Phase = "idle" | "betting" | "showdown";
export type Street = "preflop" | "flop" | "turn" | "river";

export interface WinnerInfo {
  playerId: string;
  amount: number;
  handName: string;
}

export class PokerTable {
  readonly maxSeats = 8;
  players: TablePlayer[] = [];
  hostId: string;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  phase: Phase = "idle";
  street: Street | null = null;
  community: Card[] = [];
  deck: Card[] = [];
  dealerSeat = 7;
  actorId: string | null = null;
  currentBet = 0;
  minRaise = 0;
  winners: WinnerInfo[] = [];
  log: string[] = [];
  private rng: () => number;

  constructor(opts: {
    hostId: string;
    smallBlind: number;
    bigBlind: number;
    buyIn: number;
    rng?: () => number;
  }) {
    this.hostId = opts.hostId;
    this.smallBlind = opts.smallBlind;
    this.bigBlind = opts.bigBlind;
    this.buyIn = opts.buyIn;
    this.rng = opts.rng ?? Math.random;
  }

  /** 规范化昵称用于判重（去首尾空白、大小写不敏感） */
  static normNick(nickname: string): string {
    return nickname.trim().toLowerCase();
  }

  nicknameTaken(nickname: string, exceptSessionId?: string): boolean {
    const key = PokerTable.normNick(nickname);
    if (!key) {
      return false;
    }
    return this.players.some(
      (p) =>
        PokerTable.normNick(p.nickname) === key &&
        p.sessionId !== exceptSessionId,
    );
  }

  /**
   * 入座。牌局进行中也可加入：本手 inHand=false 旁观，下一手有筹码即参战。
   */
  addPlayer(p: {
    id: string;
    sessionId: string;
    nickname: string;
    connected?: boolean;
  }): TablePlayer {
    if (this.players.length >= this.maxSeats) {
      throw new Error("房间已满（最多 8 人）");
    }
    const nickname = p.nickname.trim();
    if (!nickname) {
      throw new Error("请填写昵称");
    }
    if (this.nicknameTaken(nickname, p.sessionId)) {
      throw new Error("昵称已被使用，请换一个");
    }
    const used = new Set(this.players.map((x) => x.seat));
    let seat = 0;
    while (used.has(seat)) {
      seat += 1;
    }
    const player: TablePlayer = {
      id: p.id,
      sessionId: p.sessionId,
      nickname,
      seat,
      chips: this.buyIn,
      holeCards: null,
      folded: false,
      allIn: false,
      betThisStreet: 0,
      contrib: 0,
      hasActed: false,
      inHand: false,
      connected: p.connected ?? true,
      pendingKick: false,
      buyIns: 1,
      rebuyLocked: false,
      seatCode: this.allocSeatCode(),
      prevSessionId: null,
      isAi: false,
    };
    this.players.push(player);
    const sitOut =
      this.phase === "betting" || this.phase === "showdown"
        ? "（本局旁观，下一手参战）"
        : "";
    this.pushLog(`${player.nickname} 入座${sitOut}`);
    return player;
  }

  /** 加入 AI 玩家：生成 ai:// 会话与座位，筹码为 buyIn，本局旁观下一手参战 */
  addAiPlayer(nickname: string): TablePlayer {
    if (this.players.length >= this.maxSeats) {
      throw new Error("房间已满（最多 8 人）");
    }
    const id = `ai://${Math.random().toString(36).slice(2, 10)}`;
    const used = new Set(this.players.map((x) => x.seat));
    let seat = 0;
    while (used.has(seat)) {
      seat += 1;
    }
    const player: TablePlayer = {
      id,
      sessionId: `ai://${id}`,
      nickname,
      seat,
      chips: this.buyIn,
      holeCards: null,
      folded: false,
      allIn: false,
      betThisStreet: 0,
      contrib: 0,
      hasActed: false,
      inHand: false,
      connected: true,
      pendingKick: false,
      buyIns: 1,
      rebuyLocked: false,
      seatCode: this.allocSeatCode(),
      prevSessionId: null,
      isAi: true,
    };
    this.players.push(player);
    const sitOut =
      this.phase === "betting" || this.phase === "showdown"
        ? "（本局旁观，下一手参战）"
        : "";
    this.pushLog(`${player.nickname} 入座${sitOut}`);
    return player;
  }

  allocSeatCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let n = 0; n < 80; n += 1) {
      let code = "";
      for (let i = 0; i < 4; i += 1) {
        code += chars[Math.floor(this.rng() * chars.length)];
      }
      if (!this.players.some((p) => p.seatCode === code)) {
        return code;
      }
    }
    return `S${String(this.players.length + 1).padStart(3, "0")}`;
  }

  findBySeatCode(code: string): TablePlayer | undefined {
    const key = code.trim().toUpperCase();
    if (!key) {
      return undefined;
    }
    return this.players.find((p) => p.seatCode === key);
  }

  /** 用座位码认回座位，并把当前设备 session 绑上去 */
  claimBySeatCode(code: string, sessionId: string): TablePlayer {
    const p = this.findBySeatCode(code);
    if (!p) {
      throw new Error("座位码无效，或该座位已被请离");
    }
    if (p.sessionId !== sessionId) {
      p.prevSessionId = p.sessionId;
      p.sessionId = sessionId;
    }
    return p;
  }

  /**
   * 进房认人：有效座位码优先；过期/无效座位码忽略，再按 session 认回。
   * 被请离但尚未清座的人按原座认回，避免重连再占新座位。
   */
  pickJoinPlayer(sessionId: string, seatCode?: string): TablePlayer | undefined {
    const code = String(seatCode ?? "").trim().toUpperCase();
    if (code) {
      const seated = this.players.find((p) => p.seatCode === code);
      if (seated) {
        return this.claimBySeatCode(code, sessionId);
      }
    }
    return this.players.find(
      (p) => p.sessionId === sessionId || p.prevSessionId === sessionId,
    );
  }

  /** 重连或改名：同一 session 可更新昵称，不得与他人冲突 */
  updateNickname(playerId: string, nickname: string): void {
    const p = this.requirePlayer(playerId);
    const next = nickname.trim();
    if (!next) {
      throw new Error("请填写昵称");
    }
    if (this.nicknameTaken(next, p.sessionId)) {
      throw new Error("昵称已被使用，请换一个");
    }
    if (p.nickname !== next) {
      p.nickname = next;
    }
  }

  removePlayer(playerId: string): void {
    if (this.phase === "betting") {
      const target = this.players.find((p) => p.id === playerId);
      if (target?.inHand) {
        throw new Error("牌局进行中不能直接离座");
      }
    }
    this.players = this.players.filter((p) => p.id !== playerId);
    if (this.hostId === playerId && this.players[0]) {
      this.hostId = this.players[0].id;
      this.pushLog(`${this.players[0].nickname} 成为房主`);
    }
  }

  /**
   * 请离：旁观可立刻离座；正在打的手牌先弃牌并标记，摊牌后清走。
   * 返回是否因此推进了牌局（弃牌导致街结束/摊牌）。
   */
  kickPlayer(playerId: string): { advanced: boolean } {
    const p = this.requirePlayer(playerId);
    if (this.phase === "betting" && p.inHand) {
      p.pendingKick = true;
      const wasActor = this.actorId === playerId;
      if (!p.folded) {
        p.folded = true;
        p.hasActed = true;
        this.pushLog(`${p.nickname} 被请离`);
      }
      const shouldAdvance =
        wasActor || this.inHandLive().length <= 1 || this.bettingComplete();
      if (shouldAdvance) {
        this.afterAction();
        return { advanced: true };
      }
      return { advanced: false };
    }
    this.removePlayer(playerId);
    return { advanced: false };
  }

  flushPendingKicks(): string[] {
    const ids = this.players.filter((p) => p.pendingKick).map((p) => p.id);
    for (const id of ids) {
      this.removePlayer(id);
    }
    return ids;
  }

  /** 没筹码时再拿一手。若正好轮到自己，推进行动以免整桌卡死。 */
  rebuy(playerId: string): { advanced: boolean } {
    const p = this.requirePlayer(playerId);
    if (p.chips > 0) {
      throw new Error("仍有筹码，无需再拿");
    }
    p.chips = this.buyIn;
    p.buyIns += 1;
    const wasActor = this.actorId === playerId;
    if (this.phase === "betting" && p.inHand) {
      p.allIn = true;
      p.hasActed = true;
      p.rebuyLocked = true;
    }
    this.pushLog(`${p.nickname} 拿第 ${p.buyIns} 手（${this.buyIn}）`);
    if (this.phase === "betting" && wasActor) {
      this.afterAction();
      return { advanced: true };
    }
    return { advanced: false };
  }

  startHand(fixedDeck?: Card[]): void {
    if (this.phase === "betting") {
      throw new Error("已经在打牌");
    }
    this.flushPendingKicks();
    const eligible = this.players.filter(
      (p) => p.chips > 0 && p.connected && !p.pendingKick,
    );
    if (eligible.length < 2) {
      throw new Error("至少两名在线且有筹码的玩家才能开局");
    }
    this.winners = [];
    this.community = [];
    this.deck = fixedDeck ? [...fixedDeck] : shuffle(makeDeck(), this.rng);
    this.phase = "betting";
    this.street = "preflop";
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.actorId = null;

    for (const p of this.players) {
      p.folded = false;
      p.allIn = false;
      p.betThisStreet = 0;
      p.contrib = 0;
      p.hasActed = false;
      p.rebuyLocked = false;
      p.holeCards = null;
      p.inHand = eligible.some((e) => e.id === p.id);
    }

    this.dealerSeat = this.nextEligibleSeat(this.dealerSeat, eligible);
    const ordered = this.orderedInHand();
    const dealerIdx = ordered.findIndex((p) => p.seat === this.dealerSeat);
    let sb: TablePlayer;
    let bb: TablePlayer;
    if (ordered.length === 2) {
      sb = ordered[dealerIdx];
      bb = ordered[(dealerIdx + 1) % ordered.length];
    } else {
      sb = ordered[(dealerIdx + 1) % ordered.length];
      bb = ordered[(dealerIdx + 2) % ordered.length];
    }
    this.postBlind(sb, this.smallBlind);
    this.postBlind(bb, this.bigBlind);
    this.currentBet = Math.max(...ordered.map((p) => p.betThisStreet));
    this.minRaise = this.bigBlind;

    for (const p of ordered) {
      p.holeCards = [];
    }
    for (let round = 0; round < 2; round += 1) {
      for (const p of ordered) {
        p.holeCards!.push(this.draw());
      }
    }

    const first = ordered.length === 2
      ? sb
      : ordered[(dealerIdx + 3) % ordered.length];
    this.actorId = this.nextActorFrom(first.seat, true) ?? first.id;
    this.pushLog("新的一手开始");
  }

  legalActions(playerId: string): LegalActionsDto | null {
    if (this.phase !== "betting" || this.actorId !== playerId) {
      return null;
    }
    const p = this.requirePlayer(playerId);
    if (p.rebuyLocked) {
      return null;
    }
    const toCall = Math.max(0, this.currentBet - p.betThisStreet);
    const canCheck = toCall === 0;
    const canCall = toCall > 0 && p.chips > 0;
    const callAmount = Math.min(toCall, p.chips);
    const minRaiseTo = this.currentBet + this.minRaise;
    const maxRaiseTo = p.betThisStreet + p.chips;
    const canRaise = maxRaiseTo > this.currentBet && maxRaiseTo >= minRaiseTo;
    return {
      canFold: true,
      canCheck,
      canCall,
      callAmount,
      canRaise,
      minRaiseTo,
      maxRaiseTo,
      canAllIn: p.chips > 0,
    };
  }

  applyAction(
    playerId: string,
    action: "fold" | "check" | "call" | "raise" | "allin",
    raiseTo?: number,
  ): void {
    if (this.phase !== "betting") {
      throw new Error("当前不能行动");
    }
    if (this.actorId !== playerId) {
      throw new Error("还没轮到你");
    }
    const p = this.requirePlayer(playerId);
    const legal = this.legalActions(playerId);
    if (!legal) {
      throw new Error("没有可执行的行动");
    }

    if (action === "fold") {
      p.folded = true;
      p.hasActed = true;
      this.pushLog(`${p.nickname} 弃牌`);
    } else if (action === "check") {
      if (!legal.canCheck) {
        throw new Error("现在不能过牌");
      }
      p.hasActed = true;
      this.pushLog(`${p.nickname} 过牌`);
    } else if (action === "call") {
      if (!legal.canCall) {
        throw new Error("现在不能跟注");
      }
      this.putChips(p, legal.callAmount);
      p.hasActed = true;
      this.pushLog(`${p.nickname} 跟注 ${legal.callAmount}`);
    } else if (action === "raise") {
      if (raiseTo === undefined) {
        throw new Error("加注需要指定金额");
      }
      this.applyRaise(p, raiseTo, legal);
    } else if (action === "allin") {
      const total = p.betThisStreet + p.chips;
      if (total > this.currentBet) {
        this.applyRaise(p, total, legal, true);
      } else {
        this.putChips(p, p.chips);
        p.hasActed = true;
        this.pushLog(`${p.nickname} 全下`);
      }
    } else {
      throw new Error("未知行动");
    }

    this.afterAction();
  }

  /** 无人可再下注时连发剩余公共牌并摊牌；否则进下一街 */
  afterAction(): void {
    const live = this.inHandLive();
    if (live.length <= 1) {
      this.awardUncontested(live[0]);
      return;
    }
    if (!this.bettingComplete()) {
      this.actorId = this.nextActorFrom(this.requirePlayer(this.actorId!).seat, false);
      return;
    }
    if (this.street === "river" || this.canStillBet().length <= 1) {
      this.runoutAndShowdown();
      return;
    }
    this.nextStreet();
  }

  potTotal(): number {
    return this.players.reduce((s, p) => s + p.contrib, 0);
  }

  private applyRaise(
    p: TablePlayer,
    raiseTo: number,
    legal: LegalActionsDto,
    isAllIn = false,
  ): void {
    const maxRaiseTo = legal.maxRaiseTo;
    let target = raiseTo;
    if (isAllIn) {
      target = maxRaiseTo;
    }
    if (target < legal.minRaiseTo && target < maxRaiseTo) {
      throw new Error(`加注至少到 ${legal.minRaiseTo}`);
    }
    if (target > maxRaiseTo) {
      throw new Error("筹码不足");
    }
    if (target <= this.currentBet && !isAllIn) {
      throw new Error("加注必须超过当前注");
    }
    const increment = target - p.betThisStreet;
    this.putChips(p, increment);
    const raiseSize = p.betThisStreet - this.currentBet;
    if (p.betThisStreet > this.currentBet) {
      if (raiseSize >= this.minRaise) {
        this.minRaise = raiseSize;
        for (const o of this.inHandLive()) {
          if (o.id !== p.id && o.chips > 0) {
            o.hasActed = false;
          }
        }
      } else {
        for (const o of this.inHandLive()) {
          if (o.id !== p.id && o.chips > 0 && o.betThisStreet < p.betThisStreet) {
            o.hasActed = false;
          }
        }
      }
      this.currentBet = p.betThisStreet;
    }
    p.hasActed = true;
    const verb = isAllIn || p.allIn ? "全下" : "加注到";
    this.pushLog(`${p.nickname} ${verb} ${p.betThisStreet}`);
  }

  private nextStreet(): void {
    if (this.street === "preflop") {
      this.street = "flop";
      this.burn();
      this.community.push(this.draw(), this.draw(), this.draw());
    } else if (this.street === "flop") {
      this.street = "turn";
      this.burn();
      this.community.push(this.draw());
    } else if (this.street === "turn") {
      this.street = "river";
      this.burn();
      this.community.push(this.draw());
    }
    this.resetStreetBets();
    const actor = this.nextActorFrom(this.dealerSeat, false);
    this.actorId = actor;
    if (!actor) {
      this.runoutAndShowdown();
      return;
    }
    this.pushLog(
      this.street === "flop"
        ? "发翻牌"
        : this.street === "turn"
          ? "发转牌"
          : "发河牌",
    );
  }

  private runoutAndShowdown(): void {
    while (this.community.length < 5 && this.inHandLive().length > 1) {
      if (this.community.length === 0) {
        this.burn();
        this.community.push(this.draw(), this.draw(), this.draw());
        this.street = "flop";
      } else if (this.community.length === 3) {
        this.burn();
        this.community.push(this.draw());
        this.street = "turn";
      } else if (this.community.length === 4) {
        this.burn();
        this.community.push(this.draw());
        this.street = "river";
      }
    }
    this.showdown();
  }

  private showdown(): void {
    this.phase = "showdown";
    this.actorId = null;
    const pots = buildPots(
      this.players.map((p) => ({
        id: p.id,
        amount: p.contrib,
        folded: p.folded || !p.inHand,
      })),
    );
    const awards = new Map<string, number>();
    const names = new Map<string, string>();
    for (const pot of pots) {
      const contenders = this.players.filter(
        (p) => pot.eligible.includes(p.id) && p.holeCards && !p.folded,
      );
      if (contenders.length === 0) {
        continue;
      }
      let best = [-1];
      let winners: TablePlayer[] = [];
      for (const p of contenders) {
        const v = bestHand([...p.holeCards!, ...this.community]);
        const cmp = compareValue(v, best);
        if (cmp > 0) {
          best = v;
          winners = [p];
        } else if (cmp === 0) {
          winners.push(p);
        }
      }
      const share = Math.floor(pot.amount / winners.length);
      let rem = pot.amount - share * winners.length;
      const ordered = this.clockwiseFromDealer(winners);
      for (const w of ordered) {
        let add = share;
        if (rem > 0) {
          add += 1;
          rem -= 1;
        }
        awards.set(w.id, (awards.get(w.id) ?? 0) + add);
        names.set(w.id, handName(best));
      }
    }
    this.winners = [];
    for (const p of this.players) {
      const amt = awards.get(p.id) ?? 0;
      if (amt > 0) {
        p.chips += amt;
        this.winners.push({
          playerId: p.id,
          amount: amt,
          handName: names.get(p.id) ?? "",
        });
        this.pushLog(`${p.nickname} 赢得 ${amt}（${names.get(p.id)}）`);
      }
    }
    this.phase = "showdown";
  }

  private awardUncontested(winner?: TablePlayer): void {
    const pot = this.potTotal();
    this.phase = "showdown";
    this.actorId = null;
    if (!winner || pot <= 0) {
      this.winners = [];
      return;
    }
    winner.chips += pot;
    this.winners = [{ playerId: winner.id, amount: pot, handName: "" }];
    this.pushLog(`${winner.nickname} 赢得底池 ${pot}`);
  }

  finishShowdownToIdle(): void {
    this.flushPendingKicks();
    this.phase = "idle";
    this.street = null;
    this.community = [];
    this.actorId = null;
    this.currentBet = 0;
    for (const p of this.players) {
      p.holeCards = null;
      p.inHand = false;
      p.folded = false;
      p.allIn = false;
      p.betThisStreet = 0;
      p.contrib = 0;
      p.hasActed = false;
      p.rebuyLocked = false;
    }
  }

  private bettingComplete(): boolean {
    const live = this.inHandLive();
    if (live.length <= 1) {
      return true;
    }
    const canAct = live.filter((p) => p.chips > 0 && !p.rebuyLocked);
    if (canAct.length === 0) {
      return true;
    }
    for (const p of canAct) {
      if (p.betThisStreet < this.currentBet) {
        return false;
      }
      if (!p.hasActed) {
        return false;
      }
    }
    return true;
  }

  private canStillBet(): TablePlayer[] {
    return this.inHandLive().filter((p) => p.chips > 0 && !p.rebuyLocked);
  }

  private inHandLive(): TablePlayer[] {
    return this.players.filter((p) => p.inHand && !p.folded);
  }

  private orderedInHand(): TablePlayer[] {
    return this.players
      .filter((p) => p.inHand)
      .sort((a, b) => a.seat - b.seat);
  }

  private clockwiseFromDealer(list: TablePlayer[]): TablePlayer[] {
    return [...list].sort((a, b) => {
      const da = (a.seat - this.dealerSeat + 8) % 8;
      const db = (b.seat - this.dealerSeat + 8) % 8;
      return da - db;
    });
  }

  private nextEligibleSeat(fromSeat: number, eligible: TablePlayer[]): number {
    for (let i = 1; i <= 8; i += 1) {
      const seat = (fromSeat + i) % 8;
      const p = eligible.find((x) => x.seat === seat);
      if (p) {
        return seat;
      }
    }
    return eligible[0].seat;
  }

  private nextActorFrom(fromSeat: number, includeFrom: boolean): string | null {
    const live = this.inHandLive().filter((p) => p.chips > 0 && !p.rebuyLocked);
    if (live.length === 0) {
      return null;
    }
    const start = includeFrom ? 0 : 1;
    for (let i = start; i <= 8; i += 1) {
      const seat = (fromSeat + i) % 8;
      const p = live.find((x) => x.seat === seat);
      if (p) {
        return p.id;
      }
    }
    return null;
  }

  private resetStreetBets(): void {
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    for (const p of this.players) {
      p.betThisStreet = 0;
      if (p.inHand && !p.folded && p.chips > 0) {
        p.hasActed = false;
      } else {
        p.hasActed = true;
      }
    }
  }

  private postBlind(p: TablePlayer, amount: number): void {
    this.putChips(p, Math.min(amount, p.chips));
    p.hasActed = false;
    this.pushLog(`${p.nickname} 下盲注 ${p.betThisStreet}`);
  }

  private putChips(p: TablePlayer, amount: number): void {
    const n = Math.min(amount, p.chips);
    p.chips -= n;
    p.betThisStreet += n;
    p.contrib += n;
    if (p.chips === 0) {
      p.allIn = true;
    }
  }

  private draw(): Card {
    const c = this.deck.pop();
    if (!c) {
      throw new Error("牌堆已空");
    }
    return c;
  }

  private burn(): void {
    this.draw();
  }

  private requirePlayer(id: string): TablePlayer {
    const p = this.players.find((x) => x.id === id);
    if (!p) {
      throw new Error("找不到玩家");
    }
    return p;
  }

  private pushLog(line: string): void {
    this.log.push(line);
    if (this.log.length > 40) {
      this.log.shift();
    }
  }
}
