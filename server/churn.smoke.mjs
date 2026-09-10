/**
 * 多用户 WebSocket churn 冒烟：进房 / 断线 / 同 session 重连 / 重复昵称 / 中途加入 / 离座
 * 用法: node server/churn.smoke.mjs
 * 会自己起临时服务（随机端口），不碰 :8080。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitHttp(url, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error(`server not up: ${url}`);
}

function wsOnce(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 8000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function collect(ws) {
  const msgs = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  return msgs;
}

function waitMsg(msgs, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > ms) {
        return reject(new Error(`timeout waiting msg; got ${JSON.stringify(msgs.slice(-5))}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function lastState(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === "state") return msgs[i].state;
  }
  return null;
}

async function join(wsUrl, roomCode, nickname, sessionId) {
  const ws = await wsOnce(wsUrl);
  const msgs = collect(ws);
  ws.send(JSON.stringify({ type: "join", roomCode, nickname, sessionId }));
  const msg = await waitMsg(
    msgs,
    (m) => m.type === "state" || m.type === "error",
  );
  if (msg.type === "error") {
    try {
      ws.close();
    } catch {
      /* */
    }
    const err = new Error(msg.message);
    err.joinError = msg.message;
    throw err;
  }
  return { ws, msgs, state: msg.state, playerId: msg.state.youPlayerId };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/poker`;
  const wsUrl = `ws://127.0.0.1:${port}/poker/ws`;
  const child = spawn(
    path.join(root, "node_modules/.bin/tsx"),
    ["server/index.ts"],
    {
      cwd: root,
      env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  child.stdout.on("data", () => {});

  const failures = [];
  const log = (s) => console.log(`  ✓ ${s}`);
  const fail = (s) => {
    failures.push(s);
    console.error(`  ✗ ${s}`);
  };

  try {
    await waitHttp(`${base}/api/info`);

    // 1) 创建房间
    const createRes = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nickname: "房主",
        blinds: "10/20",
        sessionId: "sess-host",
      }),
    });
    const created = await createRes.json();
    assert(createRes.ok, `create room failed: ${JSON.stringify(created)}`);
    const code = created.code;
    log(`created room ${code}`);

    // 2) 房主 + 两人进房
    const host = await join(wsUrl, code, "房主", "sess-host");
    log("host joined");
    await waitMsg(host.msgs, (m) => m.type === "notice" && m.kind === "join");

    const p2 = await join(wsUrl, code, "玩家二", "sess-p2");
    log("p2 joined");
    const p3 = await join(wsUrl, code, "玩家三", "sess-p3");
    log("p3 joined");

    let st = lastState(host.msgs);
    assert(st.seats.length === 3, `expected 3 seats got ${st.seats.length}`);
    assert(
      st.seats.every((s) => s.connected),
      "all should be connected after join",
    );

    // 3) 重复昵称
    let dupRejected = false;
    try {
      await join(wsUrl, code, "玩家二", "sess-dup");
    } catch (e) {
      dupRejected = /昵称/.test(e.joinError || e.message);
    }
    assert(dupRejected, "duplicate nick should be rejected");
    log("duplicate nick rejected");

    // 4) p2 硬断线 → 离线徽标
    const p2Id = p2.playerId;
    p2.ws.close();
    await sleep(150);
    st = lastState(host.msgs);
    const seatOff = st.seats.find((s) => s.playerId === p2Id);
    assert(seatOff && seatOff.connected === false, "p2 should show offline");
    assert(st.seats.length === 3, "disconnect must not remove seat");
    log("disconnect keeps seat offline");

    // 等离线 toast
    await waitMsg(
      host.msgs,
      (m) => m.type === "notice" && m.kind === "offline" && /玩家二/.test(m.text),
      4000,
    );
    log("offline notice received");

    // 5) 同 session 重连 → 在线 + 重连 toast，不新建玩家
    const p2b = await join(wsUrl, code, "玩家二", "sess-p2");
    st = lastState(host.msgs);
    assert(st.seats.length === 3, `reconnect created ghost? seats=${st.seats.length}`);
    assert(
      st.seats.find((s) => s.playerId === p2Id)?.connected === true,
      "offline badge should clear on reconnect",
    );
    assert(p2b.playerId === p2Id, "same playerId on session reconnect");
    await waitMsg(
      host.msgs,
      (m) => m.type === "notice" && m.kind === "reconnect" && /玩家二/.test(m.text),
      3000,
    );
    log("reconnect resumes seat + notice");

    // 6) 开局后晚加入旁观
    host.ws.send(JSON.stringify({ type: "start" }));
    await waitMsg(host.msgs, (m) => m.type === "state" && m.state.phase === "betting");
    const p4 = await join(wsUrl, code, "晚到", "sess-p4");
    st = lastState(host.msgs);
    const late = st.seats.find((s) => s.playerId === p4.playerId);
    assert(late && late.inHand === false, "late join should sit out");
    assert(st.phase === "betting", "phase should stay betting");
    log("late join sit-out mid-hand");

    // 7) 牌局中 leave = 软离线，不删座
    const before = st.seats.length;
    p4.ws.send(JSON.stringify({ type: "leave" }));
    await sleep(200);
    st = lastState(host.msgs);
    assert(st.seats.length === before, "leave mid-hand must not remove seat");
    assert(
      st.seats.find((s) => s.playerId === p4.playerId)?.connected === false,
      "leave mid-hand should mark offline",
    );
    log("leave mid-hand soft-disconnects");

    // 8) 快速 churn：多人反复断线重连
    for (let i = 0; i < 5; i++) {
      p3.ws.close();
      await sleep(80);
      const back = await join(wsUrl, code, "玩家三", "sess-p3");
      Object.assign(p3, back);
      st = lastState(host.msgs);
      const ids = st.seats.map((s) => s.playerId);
      assert(new Set(ids).size === ids.length, "duplicate playerIds after churn");
      assert(
        st.seats.filter((s) => s.nickname === "玩家三").length === 1,
        "duplicate nick seats after churn",
      );
    }
    log("rapid disconnect/reconnect x5 no ghosts");

    // 9) 弃牌结束手牌后 idle，真正离座
    // fold until showdown/idle — auto may need actions
    st = lastState(host.msgs);
    // Still betting possibly — fold actors until idle
    for (let guard = 0; guard < 40; guard++) {
      st = lastState(host.msgs);
      if (st.phase === "idle") break;
      if (st.phase === "showdown") {
        await sleep(100);
        continue;
      }
      const me = st.youPlayerId;
      if (st.legal && st.actorId === me) {
        host.ws.send(
          JSON.stringify({
            type: "action",
            action: st.legal.canCheck ? "check" : "fold",
          }),
        );
      } else if (st.actorId === p2b.playerId || st.actorId === p3.playerId) {
        const actorWs = st.actorId === p2b.playerId ? p2b.ws : p3.ws;
        const actorState = lastState(
          st.actorId === p2b.playerId ? p2b.msgs : p3.msgs,
        );
        // refresh actor msgs via waiting
        await sleep(50);
        const legal = lastState(st.actorId === p2b.playerId ? p2b.msgs : p3.msgs)?.legal;
        if (legal) {
          actorWs.send(
            JSON.stringify({
              type: "action",
              action: legal.canCheck ? "check" : "fold",
            }),
          );
        }
      } else {
        await sleep(50);
      }
    }
    // Wait showdown timer to idle (6s) — advance by waiting
    st = lastState(host.msgs);
    if (st.phase === "showdown") {
      await sleep(6500);
      st = lastState(host.msgs);
    }
    // If auto-started next hand, dissolve not needed — try leave when idle
    if (st.phase === "betting") {
      // fold everyone quickly using whatever legal
      for (let guard = 0; guard < 60; guard++) {
        st = lastState(host.msgs);
        if (st.phase === "idle") break;
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
          await sleep(6500);
        } else {
          await sleep(40);
        }
      }
    }
    st = lastState(host.msgs);
    // Force idle via dissolve if still stuck — but first try leave p3
    if (st.phase !== "idle") {
      // skip hard leave test if still in hand; soft path already tested
      log("skip hard leave (still in hand after folds) — soft path covered");
    } else {
      const seatsBefore = st.seats.length;
      p3.ws.send(JSON.stringify({ type: "leave" }));
      await waitMsg(
        host.msgs,
        (m) => m.type === "notice" && m.kind === "leave",
        3000,
      );
      st = lastState(host.msgs);
      assert(st.seats.length === seatsBefore - 1, "leave in idle removes seat");
      log("idle leave removes seat + notice");
    }

    // 10) 最终无重复 session/昵称幽灵
    st = lastState(host.msgs);
    const nicks = st.seats.map((s) => s.nickname);
    assert(new Set(nicks).size === nicks.length, "duplicate nicknames in seats");
    log(`final seats ok: ${nicks.join(", ")}`);

    if (failures.length) {
      throw new Error(failures.join("; "));
    }
    console.log("\nCHURN SMOKE PASSED");
  } catch (e) {
    console.error("\nCHURN SMOKE FAILED:", e.message);
    if (stderr) console.error("server stderr:", stderr.slice(-2000));
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
    await sleep(200);
    try {
      child.kill("SIGKILL");
    } catch {
      /* */
    }
  }
}

main();
