/** 牌桌背景音乐与手牌语音；需用户点过页面后才能出声 */

import { holeCardsSpeech } from "@shared/cardsSpeech";
import type { CardDto } from "@shared/protocol";

const LS_BGM = "th-bgm";
const LS_SFX = "th-sfx";

function readFlag(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === "0") {
    return false;
  }
  if (raw === "1") {
    return true;
  }
  return fallback;
}

export class TableAudio {
  bgmOn = readFlag(LS_BGM, true);
  sfxOn = readFlag(LS_SFX, true);
  private ctx: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private timers: number[] = [];
  private lastHoleKey = "";

  private lastUnlock = Promise.resolve();

  unlock(): Promise<void> {
    const ctx = this.ensureCtx();
    // 串行化解锁流程，避免并发事件重复触发
    this.lastUnlock = this.lastUnlock.then(async () => {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      if (this.bgmOn) {
        this.startBgm();
      }
    });
    return this.lastUnlock;
  }

  setBgm(on: boolean): void {
    this.bgmOn = on;
    localStorage.setItem(LS_BGM, on ? "1" : "0");
    if (on) {
      this.unlock();
      this.startBgm();
    } else {
      this.stopBgm();
    }
  }

  setSfx(on: boolean): void {
    this.sfxOn = on;
    localStorage.setItem(LS_SFX, on ? "1" : "0");
    if (!on && typeof speechSynthesis !== "undefined") {
      speechSynthesis.cancel();
    }
  }

  onHoleCards(cards: CardDto[] | null): void {
    if (!cards || cards.length < 2) {
      this.lastHoleKey = "";
      return;
    }
    const key = `${cards[0].r}${cards[0].s}-${cards[1].r}${cards[1].s}`;
    if (key === this.lastHoleKey) {
      return;
    }
    this.lastHoleKey = key;
    if (!this.sfxOn) {
      return;
    }
    void this.unlock().then(() => {
      this.playDealClick();
      const text = holeCardsSpeech(cards);
      if (!text || typeof speechSynthesis === "undefined") {
        return;
      }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = 1.05;
      u.volume = 1;
      speechSynthesis.speak(u);
    });
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctx();
    }
    return this.ctx;
  }

  private startBgm(): void {
    if (this.bgmGain || !this.bgmOn) {
      return;
    }
    const ctx = this.ensureCtx();
    const master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);
    this.bgmGain = master;
    const notes = [196, 247, 294, 330, 392];
    const playNote = () => {
      if (!this.bgmGain || !this.ctx) {
        return;
      }
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = notes[Math.floor(Math.random() * notes.length)] ?? 247;
      g.gain.setValueAtTime(0, this.ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.5, this.ctx.currentTime + 0.4);
      g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 2.4);
      osc.connect(g);
      g.connect(this.bgmGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 2.5);
    };
    playNote();
    this.timers.push(window.setInterval(playNote, 2200));
  }

  private stopBgm(): void {
    for (const id of this.timers) {
      window.clearInterval(id);
    }
    this.timers = [];
    if (this.bgmGain && this.ctx) {
      this.bgmGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.2);
    }
    this.bgmGain = null;
  }

  private playDealClick(): void {
    const ctx = this.ensureCtx();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    g.gain.value = 0.25;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  }
}

export const tableAudio = new TableAudio();
