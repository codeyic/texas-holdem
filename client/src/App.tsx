/** 德州扑克网页入口：大厅开房与牌桌 */

import { QRCodeSVG } from "qrcode.react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { publicJoinUrl } from "@shared/base";
import { seatsByRail } from "@shared/feltSeat";
import { clampRaiseAmount, POT_RAISE_PRESETS, potRaiseTo } from "@shared/raiseSize";
import { QUICK_CHAT_LINES } from "@shared/quickChat";
import { isLandCompactSize, isLandscapeSize, layoutViewport, shouldPromptLandscape } from "@shared/viewport";
import { tableAudio } from "./audio";
import { randomNickname } from "@shared/nick";
import type {
  BlindPreset,
  CardDto,
  ClientMsg,
  NoticeKind,
  PublicState,
  RoomSummary,
  SeatDto,
  ServerMsg,
} from "@shared/protocol";
import { saveHand, listHands, clearHands } from "./review/db";
import { ReviewPanel } from "./review/ReviewPanel";
import { StatsView } from "./review/StatsView";
import type { HandRecord } from "@shared/protocol";

const SUIT: Record<CardDto["s"], string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};

type ConnStatus = "idle" | "connecting" | "online" | "reconnecting" | "offline";

interface ToastItem {
  id: number;
  text: string;
  kind: NoticeKind;
}

/** 持久会话：刷新 / 同浏览器多标签重进同一座位，勿用 sessionStorage */
function sessionId(): string {
  const key = "th-session";
  let s = localStorage.getItem(key);
  if (!s) {
    s = sessionStorage.getItem(key);
    if (s) {
      localStorage.setItem(key, s);
    }
  }
  if (!s) {
    s = crypto.randomUUID();
    localStorage.setItem(key, s);
  }
  sessionStorage.setItem(key, s);
  return s;
}

function rankText(r: number): string {
  if (r === 14) {
    return "A";
  }
  if (r === 13) {
    return "K";
  }
  if (r === 12) {
    return "Q";
  }
  if (r === 11) {
    return "J";
  }
  if (r === 10) {
    return "10";
  }
  return String(r);
}

function PlayingCard({ card, hidden }: { card?: CardDto | null; hidden?: boolean }) {
  if (hidden || !card) {
    return <div className="card card-back" />;
  }
  const red = card.s === "h" || card.s === "d";
  let cls = "card";
  if (red) {
    cls += " red";
  }
  return (
    <div className={cls}>
      <span className="rank">{rankText(card.r)}</span>
      <span className="suit">{SUIT[card.s]}</span>
    </div>
  );
}

function seatInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "?";
  }
  return Array.from(trimmed)[0] ?? "?";
}

function SeatBlock({
  seat,
  youPlayerId,
  phase,
  yourCards,
  buyIn,
  equity,
  isHost,
  menuOpen,
  onToggleMenu,
  onCopyCode,
  onRebuy,
  onKick,
  chatLine,
}: {
  seat: SeatDto;
  youPlayerId: string | null;
  phase: PublicState["phase"];
  yourCards: CardDto[] | null;
  buyIn: number;
  equity: number | null;
  isHost: boolean;
  menuOpen: boolean;
  onToggleMenu: (id: string) => void;
  onCopyCode: (code: string) => void;
  onRebuy: () => void;
  onKick: (id: string) => void;
  chatLine: string | null;
}) {
  let cls = "seat";
  if (seat.isActor) {
    cls += " actor";
  }
  if (seat.folded) {
    cls += " folded";
  }
  if (!seat.connected) {
    cls += " offline";
  }
  if (seat.playerId === youPlayerId) {
    cls += " you";
  }
  if (menuOpen) {
    cls += " menu-open";
  }
  const sittingOut =
    !seat.inHand && (phase === "betting" || phase === "showdown");
  if (sittingOut) {
    cls += " sitout";
  }
  const showFace =
    seat.holeCards &&
    seat.holeCards.length === 2 &&
    (seat.playerId === youPlayerId || phase === "showdown");
  const showYours =
    seat.playerId === youPlayerId && yourCards && yourCards.length === 2;
  const showBacks = seat.inHand && phase !== "idle";
  const canKick = isHost && seat.playerId !== youPlayerId;
  const streetBet = seat.betThisStreet > 0;

  return (
    <div className={cls}>
      {chatLine ? <div className="seat-bubble">{chatLine}</div> : null}
      {streetBet || seat.allIn ? (
        <div className="seat-wager">
          {seat.allIn ? <span className="tag allin">全下</span> : null}
          {streetBet ? <span className="bet">注 {seat.betThisStreet}</span> : null}
        </div>
      ) : null}
      <div className="seat-cards">
        {showFace && seat.holeCards ? (
          <>
            <PlayingCard card={seat.holeCards[0]} />
            <PlayingCard card={seat.holeCards[1]} />
          </>
        ) : showYours && yourCards ? (
          <>
            <PlayingCard card={yourCards[0]} />
            <PlayingCard card={yourCards[1]} />
          </>
        ) : showBacks ? (
          <>
            <PlayingCard hidden />
            <PlayingCard hidden />
          </>
        ) : null}
      </div>
      <div className="seat-meta">
        <button
          type="button"
          className="seat-hit"
          title={canKick ? "座位码 / 请离" : "查看座位码"}
          aria-expanded={menuOpen}
          aria-label={`${seat.nickname} 的选项`}
          onClick={() => onToggleMenu(seat.playerId)}
        >
          <span className="seat-avatar">{seatInitial(seat.nickname)}</span>
          <span className="seat-info">
            <span className="seat-name">
              {seat.isDealer ? <span className="dealer-btn">D</span> : null}
              <span className="seat-nick">{seat.nickname}</span>
              {seat.isHost ? <span className="seat-mark">房</span> : null}
              {seat.playerId === youPlayerId ? <span className="seat-mark">我</span> : null}
              {seat.isAi ? <span className="seat-mark ai">🤖</span> : null}
            </span>
            <span className="seat-stats">
              {sittingOut ? (
                <span className="seat-status sitout-label">旁观</span>
              ) : (
                <span className={`seat-status ${seat.connected ? "online" : "offline"}`}>
                  {seat.connected ? (
                    <>
                      <span className="status-dot" aria-hidden />
                      <span className="seat-status-text">在线</span>
                    </>
                  ) : (
                    <span className="seat-status-text">离线</span>
                  )}
                </span>
              )}
              <span className="stat-sep" aria-hidden>
                ·
              </span>
              <span className="chip-count">
                {seat.playerId === youPlayerId ? `${seat.chips}筹码` : seat.chips}
              </span>
              {seat.playerId === youPlayerId && equity !== null ? (
                <span className="equity-pill">{Math.round(equity * 100)}%</span>
              ) : null}
              <span className="stat-sep" aria-hidden>
                ·
              </span>
              <span className="hand-record">
                {seat.playerId === youPlayerId ? `拿${seat.buyIns}手` : `×${seat.buyIns}手`}
              </span>
            </span>
          </span>
        </button>
        {menuOpen ? (
          <div className="seat-menu">
            <div className="seat-menu-code">
              <span>座位码 {seat.seatCode}</span>
              <button type="button" onClick={() => onCopyCode(seat.seatCode)}>
                复制
              </button>
            </div>
            {canKick ? (
              <button
                type="button"
                className="seat-menu-kick"
                onClick={() => onKick(seat.playerId)}
              >
                请离
              </button>
            ) : null}
          </div>
        ) : null}
        {seat.chips === 0 && seat.playerId === youPlayerId ? (
          <button type="button" className="seat-rebuy" onClick={onRebuy}>
            拿一手 {buyIn}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function publicBase(): string {
  return import.meta.env.BASE_URL.replace(/\/$/, "");
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${publicBase()}/ws`;
}

function loadForceLand(): boolean {
  try {
    return sessionStorage.getItem("th-force-land") === "1";
  } catch {
    return false;
  }
}

function saveForceLand(on: boolean): void {
  try {
    sessionStorage.setItem("th-force-land", on ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

function boardHint(phase: PublicState["phase"], street: PublicState["street"]): string {
  if (phase === "idle") {
    return "等待开局";
  }
  if (phase === "showdown") {
    return "摊牌";
  }
  if (street === "preflop") {
    return "翻前";
  }
  if (street === "flop") {
    return "翻牌";
  }
  if (street === "turn") {
    return "转牌";
  }
  if (street === "river") {
    return "河牌";
  }
  return "发牌中";
}

function roomFromUrl(): string {
  return new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
}

function seatFromUrl(): string {
  return new URLSearchParams(location.search).get("seat")?.toUpperCase() ?? "";
}

function loadSeatCode(room: string): string {
  return (localStorage.getItem(`th-seat-${room}`) ?? "").toUpperCase();
}

function saveSeatCode(room: string, code: string): void {
  if (room && code) {
    localStorage.setItem(`th-seat-${room}`, code);
  }
}

function clearSeatCode(room: string): void {
  if (room) {
    localStorage.removeItem(`th-seat-${room}`);
  }
}

function connLabel(status: ConnStatus): string {
  if (status === "online") {
    return "已连接";
  }
  if (status === "connecting") {
    return "连接中…";
  }
  if (status === "reconnecting") {
    return "重连中…";
  }
  if (status === "offline") {
    return "已断线";
  }
  return "未入座";
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          onClick={() => onDismiss(t.id)}
          role="status"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

function defaultNickname(): string {
  const saved = (localStorage.getItem("th-nick") ?? "").trim();
  if (saved) {
    return saved;
  }
  const generated = randomNickname();
  localStorage.setItem("th-nick", generated);
  return generated;
}

function SoundToggles({
  bgmOn,
  sfxOn,
  onBgm,
  onSfx,
}: {
  bgmOn: boolean;
  sfxOn: boolean;
  onBgm: (v: boolean) => void;
  onSfx: (v: boolean) => void;
}) {
  return (
    <div className="sound-toggles">
      <button
        type="button"
        className={bgmOn ? "ghost on" : "ghost"}
        onClick={() => {
          void tableAudio.unlock();
          tableAudio.setBgm(!bgmOn);
          onBgm(!bgmOn);
        }}
      >
        {bgmOn ? "音乐开" : "音乐关"}
      </button>
      <button
        type="button"
        className={sfxOn ? "ghost on" : "ghost"}
        onClick={() => {
          void tableAudio.unlock();
          tableAudio.setSfx(!sfxOn);
          onSfx(!sfxOn);
        }}
      >
        {sfxOn ? "手牌语音开" : "手牌语音关"}
      </button>
    </div>
  );
}

function QuickChat({
  open,
  boxRef,
  onToggle,
  onPick,
}: {
  open: boolean;
  boxRef: RefObject<HTMLDivElement>;
  onToggle: () => void;
  onPick: (line: string) => void;
}) {
  return (
    <div className="quick-chat" ref={boxRef}>
      <button
        type="button"
        className={`quick-chat-btn${open ? " on" : ""}`}
        aria-expanded={open}
        aria-label="快捷聊天"
        onClick={onToggle}
      >
        聊
      </button>
      {open ? (
        <div className="quick-chat-panel">
          {QUICK_CHAT_LINES.map((line) => (
            <button
              key={line}
              type="button"
              className="quick-chat-line"
              onClick={() => onPick(line)}
            >
              {line}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TableMenu({
  menuOpen,
  menuRef,
  onToggle,
  onClose,
  physicalLand,
  useFakeLand,
  onToggleLand,
  bgmOn,
  sfxOn,
  onBgm,
  onSfx,
  showQr,
  onInvite,
  canStart,
  onStart,
  isHost,
  onAddAi,
  canRebuy,
  buyIn,
  onRebuy,
  canDissolve,
  onDissolve,
  onLeave,
  onViewReview,
  onViewStats,
}: {
  menuOpen: boolean;
  menuRef: RefObject<HTMLDivElement>;
  onToggle: () => void;
  onClose: () => void;
  physicalLand: boolean;
  useFakeLand: boolean;
  onToggleLand: () => void;
  bgmOn: boolean;
  sfxOn: boolean;
  onBgm: (v: boolean) => void;
  onSfx: (v: boolean) => void;
  showQr: boolean;
  onInvite: () => void;
  canStart: boolean;
  onStart: () => void;
  isHost: boolean;
  onAddAi: () => void;
  canRebuy: boolean;
  buyIn: number;
  onRebuy: () => void;
  canDissolve: boolean;
  onDissolve: () => void;
  onLeave: () => void;
  onViewReview: () => void;
  onViewStats: () => void;
}) {
  return (
    <div className="table-menu" ref={menuRef}>
      {physicalLand ? null : (
        <button
          type="button"
          className={`ghost ori-toggle${useFakeLand ? " on" : ""}`}
          onClick={onToggleLand}
        >
          {useFakeLand ? "竖屏" : "横屏"}
        </button>
      )}
      <button
        type="button"
        className={`ghost table-menu-btn${menuOpen ? " on" : ""}`}
        aria-expanded={menuOpen}
        aria-label="设置"
        onClick={onToggle}
      >
        设
      </button>
      {menuOpen ? (
        <div className="table-menu-panel">
          <SoundToggles bgmOn={bgmOn} sfxOn={sfxOn} onBgm={onBgm} onSfx={onSfx} />
          <button
            type="button"
            className="ghost"
            onClick={() => {
              onInvite();
              onClose();
            }}
          >
            {showQr ? "收起二维码" : "邀请"}
          </button>
          {canStart ? (
            <button
              type="button"
              className="primary"
              onClick={() => {
                onStart();
                onClose();
              }}
            >
              开始本局
            </button>
          ) : null}
          {isHost ? (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                onAddAi();
                onClose();
              }}
            >
              添加 AI
            </button>
          ) : null}
          <button
            type="button"
            className="ghost"
            onClick={() => {
              onViewReview();
              onClose();
            }}
          >
            复盘
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              onViewStats();
              onClose();
            }}
          >
            统计
          </button>
          {canRebuy ? (
            <button
              type="button"
              onClick={() => {
                onRebuy();
                onClose();
              }}
            >
              拿一手 {buyIn}
            </button>
          ) : null}
          {canDissolve ? (
            <button
              type="button"
              className="danger"
              onClick={() => {
                onDissolve();
                onClose();
              }}
            >
              解散
            </button>
          ) : null}
          <button
            type="button"
            className="ghost leave-btn"
            onClick={() => {
              onClose();
              onLeave();
            }}
          >
            退出
          </button>
        </div>
      ) : null}
    </div>
  );
}

function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
  }
}

export function App() {
  const [nickname, setNickname] = useState(defaultNickname);
  const [blinds, setBlinds] = useState<BlindPreset>("10/20");
  const [joinCode, setJoinCode] = useState(roomFromUrl);
  const [joinSeat, setJoinSeat] = useState(seatFromUrl);
  const [bgmOn, setBgmOn] = useState(() => tableAudio.bgmOn);
  const [sfxOn, setSfxOn] = useState(() => tableAudio.sfxOn);
  const [state, setState] = useState<PublicState | null>(null);
  const [handRecords, setHandRecords] = useState<HandRecord[]>([]);
  const [view, setView] = useState<"table" | "review" | "stats">("table");
  const [error, setError] = useState("");
  const [raiseTo, setRaiseTo] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [showQr, setShowQr] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [seatMenuId, setSeatMenuId] = useState<string | null>(null);
  const [chatBubbles, setChatBubbles] = useState<
    Record<string, { text: string; until: number }>
  >({});
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnStatus>("idle");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [openRooms, setOpenRooms] = useState<RoomSummary[]>([]);
  const [landCompact, setLandCompact] = useState(false);
  const [promptLandscape, setPromptLandscape] = useState(() =>
    shouldPromptLandscape(window.innerWidth, window.innerHeight),
  );
  const [physicalLand, setPhysicalLand] = useState(() =>
    isLandscapeSize(window.innerWidth, window.innerHeight),
  );
  const [forceLand, setForceLand] = useState(loadForceLand);
  const [portraitOk, setPortraitOk] = useState(true); /* 竖屏直接可玩，不挡门槛 */
  const menuRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const toastIdRef = useRef(0);
  const recentToastRef = useRef<Map<string, number>>(new Map());

  const pushToast = useCallback((text: string, kind: NoticeKind) => {
    const key = `${kind}:${text}`;
    const last = recentToastRef.current.get(key) ?? 0;
    const t = Date.now();
    // 同文案 3 秒内不重复弹，避免刷屏
    if (t - last < 3000) {
      return;
    }
    recentToastRef.current.set(key, t);
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-4), { id, text, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 3800);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const loadHands = useCallback(async () => {
    const hs = await listHands();
    setHandRecords(hs);
  }, []);

  useEffect(() => {
    void loadHands();
  }, [loadHands]);

  const roomCodeRef = useRef<string>("");
  const nickRef = useRef<string>("");
  const seatCodeRef = useRef<string>(seatFromUrl());
  const intentionalCloseRef = useRef(false);
  const leavingRef = useRef(false);
  const joinedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(
    (code: string, nick: string, opts?: { reconnecting?: boolean; seatCode?: string }) => {
      roomCodeRef.current = code;
      nickRef.current = nick;
      if (opts?.seatCode) {
        seatCodeRef.current = opts.seatCode.toUpperCase();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      // 主动替换连接时不要触发旧 socket 的重连逻辑
      intentionalCloseRef.current = true;
      try {
        wsRef.current?.close();
      } catch {
        /* 忽略 */
      }
      intentionalCloseRef.current = false;
      joinedRef.current = false;
      leavingRef.current = false;
      setConnStatus(opts?.reconnecting ? "reconnecting" : "connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        setError("无法连接服务器，请检查网络后重试");
        setConnStatus("offline");
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "join",
            roomCode: code,
            nickname: nick,
            sessionId: sessionId(),
            seatCode: seatCodeRef.current || undefined,
          } satisfies ClientMsg),
        );
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (msg.type === "error") {
          setError(msg.message);
          return;
        }
        if (msg.type === "notice") {
          pushToast(msg.text, msg.kind);
          return;
        }
        if (msg.type === "chat") {
          const until = Date.now() + 3000;
          setChatBubbles((prev) => ({
            ...prev,
            [msg.playerId]: { text: msg.text, until },
          }));
          return;
        }
        if (msg.type === "review") {
          setHandRecords((prev) => [msg.record, ...prev]);
          pushToast("本手已生成复盘，可查看", "info");
          saveHand(msg.record).catch(() => {
            pushToast("复盘保存失败（本地存储不可用）", "error");
          });
          return;
        }
        if (msg.type !== "state") {
          return;
        }
        joinedRef.current = true;
        setConnStatus("online");
        setError("");
        setState(msg.state);
        const mine = msg.state.seats.find(
          (s) => s.playerId === msg.state.youPlayerId,
        );
        if (mine?.seatCode) {
          seatCodeRef.current = mine.seatCode;
          saveSeatCode(msg.state.roomCode, mine.seatCode);
          setJoinSeat(mine.seatCode);
        }
        tableAudio.onHoleCards(msg.state.yourCards);
        const legal = msg.state.legal;
        if (legal?.canRaise) {
          setRaiseTo(legal.minRaiseTo);
        }
      };
      ws.onerror = () => {
        setError("连接失败（WebSocket）。请确认使用 https://codeyc.top/poker/ 访问");
      };
      ws.onclose = () => {
        if (intentionalCloseRef.current || leavingRef.current) {
          if (leavingRef.current) {
            setConnStatus("idle");
          }
          return;
        }
        setConnStatus("reconnecting");
        // 仅已成功入座后断线才自动重连（同一 sessionId 恢复座位）
        if (joinedRef.current && roomCodeRef.current && nickRef.current) {
          reconnectTimerRef.current = setTimeout(() => {
            connect(roomCodeRef.current, nickRef.current, { reconnecting: true });
          }, 1200);
        } else {
          setConnStatus("offline");
        }
      };
    },
    [pushToast],
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const playing = Boolean(state);
    document.documentElement.classList.toggle("table-playing", playing);
    return () => {
      document.documentElement.classList.remove("table-playing");
    };
  }, [state]);

  useEffect(() => {
    const apply = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const fake = forceLand && !isLandscapeSize(w, h);
      const vp = layoutViewport(w, h, fake);
      setPhysicalLand(isLandscapeSize(w, h));
      setLandCompact(isLandCompactSize(vp.width, vp.height));
      setPromptLandscape(shouldPromptLandscape(w, h));
    };
    apply();
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, [forceLand]);

  useEffect(() => {
    const fake = forceLand && !physicalLand;
    document.documentElement.classList.toggle("force-land", fake);
    return () => {
      document.documentElement.classList.remove("force-land");
    };
  }, [forceLand, physicalLand]);

  useEffect(() => {
    if (!state?.legal?.canRaise) {
      setRaiseOpen(false);
    }
  }, [state?.legal?.canRaise]);

  useEffect(() => {
    if (!menuOpen && !chatOpen && !seatMenuId) {
      return;
    }
    const onDoc = (ev: MouseEvent) => {
      const target = ev.target as Node;
      const el = menuRef.current;
      if (menuOpen && el && !el.contains(target)) {
        setMenuOpen(false);
      }
      const chatEl = chatRef.current;
      if (chatOpen && chatEl && !chatEl.contains(target)) {
        setChatOpen(false);
      }
      if (seatMenuId) {
        const node = target as Element;
        if (typeof node.closest === "function") {
          if (node.closest(".seat-hit") || node.closest(".seat-menu")) {
            return;
          }
        }
        setSeatMenuId(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
    };
  }, [menuOpen, chatOpen, seatMenuId]);

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, []);

  // 带 ?room= 时自动进房（无昵称则用随机名）
  useEffect(() => {
    const code = roomFromUrl();
    const nick = defaultNickname();
    setNickname(nick);
    const seat = (seatFromUrl() || loadSeatCode(code)).toUpperCase();
    if (seat) {
      setJoinSeat(seat);
      seatCodeRef.current = seat;
    }
    if (code && !state) {
      setJoinCode(code);
      connect(code, nick, { seatCode: seat || undefined });
    }
    // 仅挂载时尝试一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${publicBase()}/api/rooms`);
        const data = await res.json();
        if (!cancelled && Array.isArray(data.rooms)) {
          setOpenRooms(data.rooms);
        }
      } catch {
        /* 大厅列表失败时不影响开房 */
      }
    };
    void load();
    const t = window.setInterval(() => {
      void load();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [state]);

  const createRoom = async () => {
    void tableAudio.unlock();
    const nick = (nickname.trim() || defaultNickname());
    setNickname(nick);
    localStorage.setItem("th-nick", nick);
    const res = await fetch(`${publicBase()}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: nick, blinds, sessionId: sessionId() }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "创建失败");
      return;
    }
    const usedNick = String(data.nickname ?? nick);
    setNickname(usedNick);
    localStorage.setItem("th-nick", usedNick);
    if (data.seatCode) {
      saveSeatCode(data.code, data.seatCode);
      seatCodeRef.current = data.seatCode;
      setJoinSeat(data.seatCode);
    }
    const url = new URL(location.href);
    url.searchParams.set("room", data.code);
    if (data.seatCode) {
      url.searchParams.set("seat", data.seatCode);
    }
    history.replaceState(null, "", url);
    connect(data.code, usedNick, { seatCode: data.seatCode });
  };

  const joinRoom = (codeArg?: string) => {
    void tableAudio.unlock();
    const nick = nickname.trim() || defaultNickname();
    const code = (codeArg ?? joinCode).trim().toUpperCase();
    if (!code) {
      setError("请选择或输入房间号");
      return;
    }
    const seat = joinSeat.trim().toUpperCase();
    setNickname(nick);
    localStorage.setItem("th-nick", nick);
    if (seat) {
      seatCodeRef.current = seat;
      saveSeatCode(code, seat);
    } else {
      seatCodeRef.current = "";
    }
    const url = new URL(location.href);
    url.searchParams.set("room", code);
    if (seat) {
      url.searchParams.set("seat", seat);
    } else {
      url.searchParams.delete("seat");
    }
    history.replaceState(null, "", url);
    connect(code, nick, { seatCode: seat || undefined });
  };

  const leaveRoom = () => {
    leavingRef.current = true;
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    send({ type: "leave" });
    try {
      wsRef.current?.close();
    } catch {
      /* 忽略 */
    }
    const leftRoom = roomCodeRef.current;
    clearSeatCode(leftRoom);
    seatCodeRef.current = "";
    setJoinSeat("");
    setState(null);
    setView("table");
    setConnStatus("idle");
    const url = new URL(location.href);
    url.searchParams.delete("room");
    url.searchParams.delete("seat");
    history.replaceState(null, "", url);
    pushToast("你已离开房间", "leave");
  };

  const remainSec = useMemo(() => {
    if (!state?.actionDeadline) {
      return null;
    }
    return Math.max(0, Math.ceil((state.actionDeadline - now) / 1000));
  }, [state?.actionDeadline, now]);

  if (!state) {
    return (
      <div className="page lobby">
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
        <header className="hero">
          <p className="eyebrow">CODEYC · 朋友局</p>
          <h1>德州扑克</h1>
          <p className="sub">局域网开房，筹码娱乐。手机竖屏也能打，人多可点横屏</p>
        </header>
        <SoundToggles
          bgmOn={bgmOn}
          sfxOn={sfxOn}
          onBgm={setBgmOn}
          onSfx={setSfxOn}
        />
        <div className="panel">
          <label>
            昵称
            <div className="split">
              <input
                value={nickname}
                maxLength={12}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="随机已填，可改"
              />
              <button
                type="button"
                className="ghost nick-refresh"
                onClick={() => {
                  const n = randomNickname();
                  setNickname(n);
                  localStorage.setItem("th-nick", n);
                }}
              >
                换一个
              </button>
            </div>
          </label>
          <label>
            盲注
            <select
              value={blinds}
              onChange={(e) => setBlinds(e.target.value as BlindPreset)}
            >
              <option value="5/10">5 / 10</option>
              <option value="10/20">10 / 20</option>
              <option value="25/50">25 / 50</option>
            </select>
          </label>
          <button className="primary" onClick={createRoom}>
            创建房间
          </button>
          <div className="split">
            <input
              value={joinCode}
              maxLength={4}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="房间号"
            />
            <input
              value={joinSeat}
              maxLength={4}
              onChange={(e) => setJoinSeat(e.target.value.toUpperCase())}
              placeholder="座位码（选填）"
            />
            <button type="button" className="primary join-btn" onClick={() => joinRoom()}>加入</button>
          </div>
          <p className="muted small">换设备回来：填房间号 + 座位码。桌上每个人的座位码别人也能看见，方便帮忙。</p>
          {error ? <p className="err">{error}</p> : null}
        </div>
        <div className="panel room-list">
          <h2>在线房间</h2>
          {openRooms.length === 0 ? (
            <p className="muted">当前没有有人在线的房间，创建一个吧</p>
          ) : (
            <ul>
              {openRooms.map((r) => {
                let phaseText = "等人";
                if (r.phase === "betting") {
                  phaseText = "牌局中";
                } else if (r.phase === "showdown") {
                  phaseText = "摊牌中";
                }
                const full = r.seated >= r.maxSeats;
                return (
                  <li key={r.code}>
                    <div>
                      <strong>{r.code}</strong>
                      <span className="muted">
                        {" "}
                        {r.smallBlind}/{r.bigBlind} · {r.connected} 人在线 · {phaseText}
                      </span>
                      <p className="muted small">{r.names.join("、")}</p>
                    </div>
                    <button
                      disabled={full}
                      onClick={() => {
                        setJoinCode(r.code);
                        joinRoom(r.code);
                      }}
                    >
                      {full ? "已满" : "加入"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="foot">仅供娱乐，不涉及真实货币</p>
      </div>
    );
  }

  if (state && view === "review") {
    return (
      <ReviewPanel
        records={handRecords}
        onClear={() => {
          void clearHands();
          setHandRecords([]);
        }}
        onBack={() => setView("table")}
      />
    );
  }
  if (state && view === "stats") {
    return (
      <StatsView records={handRecords} onBack={() => setView("table")} />
    );
  }

  const you = state.seats.find((s) => s.playerId === state.youPlayerId);
  const ordered = [...state.seats].sort((a, b) => a.seat - b.seat);
  const myIndex = ordered.findIndex((s) => s.playerId === state.youPlayerId);
  const rotated =
    myIndex >= 0
      ? [...ordered.slice(myIndex), ...ordered.slice(0, myIndex)]
      : ordered;
  const joinUrl = publicJoinUrl(state.roomCode);
  const isHost = state.youPlayerId === state.hostId;
  const canStart =
    isHost &&
    state.phase === "idle" &&
    state.seats.filter((s) => s.chips > 0 && s.connected).length >= 2;
  const canRebuy = Boolean(you && you.chips === 0);
  const streetLabel = boardHint(state.phase, state.street);
  let raiseSend = raiseTo;
  if (state.legal && state.legal.canRaise) {
    if (raiseSend < state.legal.minRaiseTo) {
      raiseSend = state.legal.minRaiseTo;
    }
    if (raiseSend > state.legal.maxRaiseTo) {
      raiseSend = state.legal.maxRaiseTo;
    }
  }

  const rails = seatsByRail(rotated);
  const useFakeLand = forceLand && !physicalLand;
  const showLandHint = promptLandscape && !portraitOk && !useFakeLand;

  const renderSeat = (seat: SeatDto) => {
    const bubble = chatBubbles[seat.playerId];
    let chatLine: string | null = null;
    if (bubble && now < bubble.until) {
      chatLine = bubble.text;
    }
    return (
    <SeatBlock
      key={seat.playerId}
      seat={seat}
      youPlayerId={state.youPlayerId}
      phase={state.phase}
      yourCards={state.yourCards}
      buyIn={state.buyIn}
      equity={state.equity}
      isHost={isHost}
      menuOpen={seatMenuId === seat.playerId}
      onToggleMenu={(id) => {
        if (seatMenuId === id) {
          setSeatMenuId(null);
          return;
        }
        setSeatMenuId(id);
      }}
      onCopyCode={(code) => {
        copyText(code);
        pushToast(`已复制 ${code}`, "info");
      }}
      onRebuy={() => send({ type: "rebuy" })}
      onKick={(id) => {
        send({ type: "kick", playerId: id });
        setSeatMenuId(null);
      }}
      chatLine={chatLine}
    />
    );
  };

  return (
    <div className={`table-rotator${useFakeLand ? " is-on" : ""}`}>
    <div
      className={`page table-page${landCompact ? " land-compact" : ""}${showLandHint ? " show-land-hint" : ""}`}
    >
      <div className="land-mask" hidden={!showLandHint}>
        <p>建议横屏游玩</p>
        <span>微信里通常转不了屏，可点「网页横屏」</span>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setForceLand(true);
            saveForceLand(true);
            setPortraitOk(true);
          }}
        >
          网页横屏
        </button>
        <button type="button" className="ghost" onClick={() => setPortraitOk(true)}>
          竖屏继续
        </button>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <div className="topbar">
        <div className="top-info">
          <div className="top-title-row">
            <strong>房间 {state.roomCode}</strong>
            <span className={`conn-pill conn-${connStatus}`} title="连接状态">
              <span className="conn-dot" />
              <span className="conn-label">{connLabel(connStatus)}</span>
            </span>
          </div>
          <div className="meta-chips">
            <span className="pill">盲注 {state.smallBlind}/{state.bigBlind}</span>
            <span className="pill">{streetLabel}</span>
          </div>
        </div>
        <TableMenu
          menuOpen={menuOpen}
          menuRef={menuRef}
          onToggle={() => setMenuOpen((v) => !v)}
          onClose={() => setMenuOpen(false)}
          physicalLand={physicalLand}
          useFakeLand={useFakeLand}
          onToggleLand={() => {
            const next = !forceLand;
            setForceLand(next);
            saveForceLand(next);
            setPortraitOk(true);
          }}
          bgmOn={bgmOn}
          sfxOn={sfxOn}
          onBgm={setBgmOn}
          onSfx={setSfxOn}
          showQr={showQr}
          onInvite={() => setShowQr((v) => !v)}
          canStart={canStart}
          onStart={() => send({ type: "start" })}
          isHost={isHost}
          onAddAi={() => send({ type: "add_ai" })}
          onViewReview={() => setView("review")}
          onViewStats={() => setView("stats")}
          canRebuy={canRebuy}
          buyIn={state.buyIn}
          onRebuy={() => send({ type: "rebuy" })}
          canDissolve={isHost && state.phase !== "betting"}
          onDissolve={() => send({ type: "dissolve" })}
          onLeave={leaveRoom}
        />
      </div>

      {showQr ? (
        <div className="invite">
          <QRCodeSVG value={joinUrl} size={96} />
          <div>
            <p>扫码或输入房间号 {state.roomCode}</p>
            <p className="muted small">公网（手机请用这个）{joinUrl}</p>
            {state.lanUrls
              .filter((u) => !u.includes("codeyc.top"))
              .map((u) => (
                <p className="muted small" key={u}>
                  同网备用 {u}/?room={state.roomCode}
                </p>
              ))}
          </div>
        </div>
      ) : null}

      {error ? <p className="err banner">{error}</p> : null}

      <div className="felt-wrap">
        <div
          className={`felt-grid${rails.west.length === 0 ? " west-empty" : ""}${rails.east.length === 0 ? " east-empty" : ""}${rails.west.length === 0 && rails.east.length === 0 ? " sides-empty" : ""}`}
        >
          <div className="rail rail-north">{rails.north.map(renderSeat)}</div>
          <div className="rail rail-west">{rails.west.map(renderSeat)}</div>
          <div className="felt-center">
            <div className="felt">
              <div className="board-stack">
                <div className="board">
                  {state.community.length === 0 ? (
                    <p className="waiting">{streetLabel}</p>
                  ) : (
                    state.community.map((c, i) => <PlayingCard key={i} card={c} />)
                  )}
                </div>
                <div className="pot-chip">
                  <span className="pot-label">POT</span>
                  <span className="pot-value">{state.pot}</span>
                  {state.currentBet > 0 && state.phase === "betting" ? (
                    <span className="pot-bet">注 {state.currentBet}</span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
          <div className="rail rail-east">{rails.east.map(renderSeat)}</div>
          <div className="rail rail-south">{rails.south.map(renderSeat)}</div>
        </div>
      </div>

      {state.winners.length > 0 && state.phase === "showdown" ? (
        <div className="winners">
          {state.winners.map((w) => {
            const name =
              state.seats.find((s) => s.playerId === w.playerId)?.nickname ?? "";
            return (
              <span key={w.playerId}>
                {name} +{w.amount}
                {w.handName ? `（${w.handName}）` : ""}
              </span>
            );
          })}
        </div>
      ) : null}

      <ul className="log">
        {state.log.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>

      <div className="table-dock">
      <QuickChat
        open={chatOpen}
        boxRef={chatRef}
        onToggle={() => setChatOpen((v) => !v)}
        onPick={(line) => {
          send({ type: "chat", text: line });
          setChatOpen(false);
        }}
      />
      <div className={`actions ${state.legal ? "your-turn" : ""}${raiseOpen ? " raise-open" : ""}`}>
        {state.legal ? (
          <>
            <div className="turn-bar">
              <p className="turn-hint">
                轮到你了
                {remainSec !== null ? ` · ${remainSec}s` : ""}
              </p>
              {remainSec !== null ? (
                <div className="timer-track">
                  <div
                    className="timer-fill"
                    style={{ width: `${Math.min(100, (remainSec / 20) * 100)}%` }}
                  />
                </div>
              ) : null}
            </div>
            {state.legal.canRaise && raiseOpen ? (
              <div className="raise-pop">
                <div className="raise-presets">
                  {POT_RAISE_PRESETS.map((preset) => {
                    const legal = state.legal;
                    if (!legal) {
                      return null;
                    }
                    const sized = potRaiseTo({
                      pot: state.pot,
                      currentBet: state.currentBet,
                      callAmount: legal.callAmount,
                      minRaiseTo: legal.minRaiseTo,
                      maxRaiseTo: legal.maxRaiseTo,
                      fraction: preset.fraction,
                    });
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        className="raise-preset"
                        onClick={() => setRaiseTo(sized)}
                      >
                        {preset.label}
                        <span>{sized}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="raise-group">
                  <input
                    type="range"
                    min={state.legal.minRaiseTo}
                    max={state.legal.maxRaiseTo}
                    value={raiseSend}
                    onChange={(e) => setRaiseTo(Number(e.target.value))}
                    aria-label="加注滑条"
                  />
                  <input
                    type="number"
                    className="raise-amt"
                    min={state.legal.minRaiseTo}
                    max={state.legal.maxRaiseTo}
                    value={raiseSend}
                    onChange={(e) => {
                      const legal = state.legal;
                      if (!legal) {
                        return;
                      }
                      if (!legal.canRaise) {
                        return;
                      }
                      setRaiseTo(
                        clampRaiseAmount(
                          Number(e.target.value),
                          legal.minRaiseTo,
                          legal.maxRaiseTo,
                        ),
                      );
                    }}
                    aria-label="加注金额"
                  />
                </div>
                <button
                  className="act-raise"
                  onClick={() => {
                    send({
                      type: "action",
                      action: "raise",
                      raiseTo: raiseSend,
                    });
                    setRaiseOpen(false);
                  }}
                >
                  加注到 {raiseSend}
                </button>
              </div>
            ) : null}
            <div className="btns">
              <button
                className="act-fold"
                onClick={() => send({ type: "action", action: "fold" })}
              >
                弃牌
              </button>
              {state.legal.canCheck ? (
                <button
                  className="act-check"
                  onClick={() => send({ type: "action", action: "check" })}
                >
                  过牌
                </button>
              ) : null}
              {state.legal.canCall ? (
                <button
                  className="act-call"
                  onClick={() => send({ type: "action", action: "call" })}
                >
                  跟注 {state.legal.callAmount}
                </button>
              ) : null}
              {state.legal.canRaise ? (
                <button
                  type="button"
                  className={`act-raise${raiseOpen ? " on" : ""}`}
                  onClick={() => setRaiseOpen((v) => !v)}
                >
                  {raiseOpen ? "收起" : "加注"}
                </button>
              ) : null}
              {state.legal.canAllIn ? (
                <button
                  className="danger act-allin"
                  onClick={() => send({ type: "action", action: "allin" })}
                >
                  全下
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="turn-hint">
            {you &&
            !you.inHand &&
            (state.phase === "betting" || state.phase === "showdown")
              ? "已入座：本局旁观，下一手自动参战"
              : state.phase === "idle"
                ? canStart
                  ? "人齐了，可以开始"
                  : "等待房主开始"
                : remainSec !== null
                  ? `等待对方行动 ${remainSec}s`
                  : "等待行动"}
          </p>
        )}
      </div>
      </div>
      <p className="foot">仅供娱乐，不涉及真实货币</p>
    </div>
    </div>
  );
}
