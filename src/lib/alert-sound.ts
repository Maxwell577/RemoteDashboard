"use client";

/**
 * Tiny WebAudio alert blips — no audio assets required.
 * Critical = three descending beeps, warning = double beep, info = soft single.
 * The AudioContext is created lazily and reused across alerts.
 */
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function beep(
  ac: AudioContext,
  freq: number,
  startOffset: number,
  duration = 0.09,
): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // soft attack/decay envelope so it never clicks
  const t0 = ac.currentTime + startOffset;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.05, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playAlertSound(
  severity: "info" | "warning" | "critical",
): void {
  const ac = getCtx();
  if (!ac) return;
  try {
    if (severity === "critical") {
      beep(ac, 740, 0);
      beep(ac, 554, 0.14);
      beep(ac, 392, 0.28, 0.14);
    } else if (severity === "warning") {
      beep(ac, 620, 0);
      beep(ac, 620, 0.16);
    } else {
      beep(ac, 520, 0, 0.07);
    }
  } catch {
    // audio is best-effort — never break the UI over a beep
  }
}

/**
 * Presence blips for device connect/disconnect transitions.
 * up = rising fifth (agent came online), down = falling minor third (agent left).
 */
export function playPresenceSound(up: boolean): void {
  const ac = getCtx();
  if (!ac) return;
  try {
    if (up) {
      beep(ac, 440, 0, 0.08);
      beep(ac, 660, 0.11, 0.11);
    } else {
      beep(ac, 494, 0, 0.08);
      beep(ac, 415, 0.11, 0.13);
    }
  } catch {
    // audio is best-effort — never break the UI over a beep
  }
}
