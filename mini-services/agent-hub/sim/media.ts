// SVG "capture" generators for the simulated agents: desktop screenshots
// (1600×900, live taskbar clock + current metrics) and small poster frames
// used as dataRef previews for recordings/streams.

import { fmtUptime } from "../util";

export function toDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export interface DesktopOpts {
  hostname: string;
  ip: string;
  osLabel: string;
  agentVersion: string;
  cpu: number;
  mem: number;
  disk: number;
  /** per-frame jittered network throughput so live-view frames visibly differ */
  netUpKBps: number;
  netDownKBps: number;
  uptimeSec: number;
  cpuHistory: number[];
  palette: [string, string, string];
  accent: string;
  now: Date;
  /** render size (default 1600×900); recordings use 1280×720 */
  w?: number;
  h?: number;
  /** 0 = primary monitor layout; 1 = second-monitor variant (different wallpaper hue + window layout) */
  variant?: number;
}

export function svgDesktop(o: DesktopOpts): string {
  const W = o.w ?? 1600;
  const H = o.h ?? 900;
  const v1 = o.variant === 1;
  // seconds precision → every live-view frame renders a unique clock
  const time = o.now.toTimeString().slice(0, 8);
  const netUp = o.netUpKBps >= 1024 ? `${(o.netUpKBps / 1024).toFixed(1)} MB/s` : `${Math.round(o.netUpKBps)} KB/s`;
  const netDown = o.netDownKBps >= 1024 ? `${(o.netDownKBps / 1024).toFixed(1)} MB/s` : `${Math.round(o.netDownKBps)} KB/s`;
  const date = o.now.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  // Second-monitor variant: distinct violet wallpaper hue + mirrored window layout.
  const [c1, c2, c3] = v1 ? (["#160b2b", "#37206b", "#5b21b6"] as [string, string, string]) : o.palette;
  const a = v1 ? "#c4b5fd" : o.accent;
  const winX = v1 ? Math.round(W * 0.15) : Math.round(W * 0.225);
  const winY = v1 ? Math.round(H * 0.2) : Math.round(H * 0.122);
  const winW = v1 ? Math.round(W * 0.56) : Math.round(W * 0.5625);
  const winH = v1 ? Math.round(H * 0.62) : Math.round(H * 0.689);
  const cardsX = v1 ? winX + winW + 24 : Math.round(W * 0.619);

  // Layout scales with the render size so 1280×720 recording frames and
  // 1600×900 live frames both compose correctly.
  const wsc = winW / 900;
  const sc = winH / 620;
  const barW = Math.round(560 * wsc);
  const mkBar = (label: string, v: number, y: number): string => {
    const bw = Math.round((Math.min(100, Math.max(0, v)) / 100) * barW);
    return `<text x="40" y="${y + 18}" font-family="Segoe UI,Arial" font-size="15" fill="#e8f6f2" opacity="0.85">${label}</text>
    <rect x="100" y="${y}" width="${barW}" height="22" rx="11" fill="rgba(255,255,255,0.10)"/>
    <rect x="100" y="${y}" width="${bw}" height="22" rx="11" fill="url(#barGrad)"/>
    <text x="${Math.round(676 * wsc)}" y="${y + 18}" font-family="Segoe UI,Arial" font-size="15" fill="#e8f6f2">${Math.round(v)}%</text>`;
  };

  const hist = o.cpuHistory.length >= 2 ? o.cpuHistory.slice(-32) : [o.cpu || 12, o.cpu || 12];
  const sx = 40;
  const sy = Math.round(342 * sc);
  const sw = Math.round(560 * wsc);
  const sh = Math.round(130 * sc);
  const step = sw / Math.max(1, hist.length - 1);
  const pts = hist
    .map((v, i) => `${(sx + i * step).toFixed(1)},${(sy + sh - (Math.min(100, Math.max(0, v)) / 100) * sh).toFixed(1)}`)
    .join(" ");

  const iconLabels = ["This PC", "Recycle Bin", "Sentra Agent", "Documents"];
  const mkIcon = (label: string, x: number, y: number): string =>
    `<g transform="translate(${x} ${y})">
      <rect width="56" height="56" rx="12" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.25)"/>
      <rect x="14" y="18" width="28" height="20" rx="4" fill="rgba(255,255,255,0.55)"/>
      <text x="28" y="82" text-anchor="middle" font-family="Segoe UI,Arial" font-size="13" fill="rgba(255,255,255,0.92)">${label}</text>
    </g>`;
  const icons = v1
    ? iconLabels.map((label, i) => mkIcon(label, 40 + i * 150, H - 156)).join("\n  ")
    : iconLabels.map((label, i) => mkIcon(label, 48, 64 + i * 108)).join("\n  ");

  const taskIcons = [0, 1, 2, 3, 4]
    .map((i) => `<rect x="${86 + i * 52}" y="${H - 36}" width="36" height="36" rx="9" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.16)"/>`)
    .join("\n    ");

  const cardY = (base: number): number => Math.round(winY + base * sc);
  const card = (label: string, value: string, y: number): string =>
    `<rect x="${cardsX}" y="${y}" width="240" height="38" rx="8" fill="rgba(255,255,255,0.06)"/>
    <text x="${cardsX + 12}" y="${y + 15}" font-family="Segoe UI,Arial" font-size="10" fill="rgba(255,255,255,0.5)" letter-spacing="1.5">${label}</text>
    <text x="${cardsX + 12}" y="${y + 31}" font-family="Segoe UI,Arial" font-size="13" fill="rgba(255,255,255,0.9)">${value}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="0.55" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/>
    </linearGradient>
    <linearGradient id="barGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="#f0fdfa"/>
    </linearGradient>
    <filter id="blur60" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="60"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#wall)"/>
  <circle cx="${Math.round(W * 0.78)}" cy="${Math.round(H * 0.17)}" r="${Math.round(H * 0.27)}" fill="${a}" opacity="0.20" filter="url(#blur60)"/>
  <circle cx="${Math.round(W * 0.19)}" cy="${Math.round(H * 0.82)}" r="${Math.round(H * 0.24)}" fill="#000000" opacity="0.18" filter="url(#blur60)"/>
  <circle cx="${Math.round(W * 0.475)}" cy="${Math.round(H * 0.47)}" r="${Math.round(H * 0.36)}" fill="#ffffff" opacity="0.05" filter="url(#blur60)"/>
  ${icons}
  <g transform="translate(${winX} ${winY})">
    <rect width="${winW}" height="${winH}" rx="16" fill="rgba(13,18,22,0.84)" stroke="rgba(255,255,255,0.16)"/>
    <rect width="${winW}" height="44" rx="16" fill="rgba(255,255,255,0.06)"/>
    <rect y="28" width="${winW}" height="16" fill="rgba(255,255,255,0.06)"/>
    <circle cx="${winW - 38}" cy="22" r="7" fill="#f87171"/><circle cx="${winW - 62}" cy="22" r="7" fill="#fbbf24"/><circle cx="${winW - 86}" cy="22" r="7" fill="#34d399"/>
    <text x="${Math.round(winW / 2)}" y="28" text-anchor="middle" font-family="Segoe UI,Arial" font-size="15" fill="rgba(255,255,255,0.88)">Sentra Agent — ${o.hostname}${v1 ? " · Display 2" : ""}</text>
    <text x="36" y="90" font-family="Segoe UI,Arial" font-size="13" fill="${a}" letter-spacing="2">SYSTEM MONITOR</text>
    <text x="36" y="116" font-family="Segoe UI,Arial" font-size="14" fill="rgba(255,255,255,0.65)">${o.osLabel} · ${o.ip} · agent v${o.agentVersion} · uptime ${fmtUptime(o.uptimeSec)}</text>
    ${mkBar("CPU", o.cpu, Math.round(158 * sc))}
    ${mkBar("RAM", o.mem, Math.round(202 * sc))}
    ${mkBar("DISK", o.disk, Math.round(246 * sc))}
    <text x="40" y="${Math.round(302 * sc)}" font-family="Segoe UI,Arial" font-size="15" fill="#e8f6f2" opacity="0.85">NET</text>
    <text x="100" y="${Math.round(302 * sc)}" font-family="Consolas,monospace" font-size="15" fill="#7ef0cf">↑ ${netUp}</text>
    <text x="${Math.round(280 * wsc)}" y="${Math.round(302 * sc)}" font-family="Consolas,monospace" font-size="15" fill="#7ec8f0">↓ ${netDown}</text>
    <text x="36" y="${Math.round(322 * sc)}" font-family="Segoe UI,Arial" font-size="13" fill="rgba(255,255,255,0.65)" letter-spacing="2">CPU — LAST ${hist.length} SAMPLES</text>
    <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="10" fill="rgba(255,255,255,0.05)"/>
    <line x1="${sx}" y1="${sy + sh}" x2="${sx + sw}" y2="${sy + sh}" stroke="rgba(255,255,255,0.15)"/>
    <polyline points="${pts}" fill="none" stroke="${a}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="36" y="${Math.round(526 * sc)}" font-family="Segoe UI,Arial" font-size="13" fill="rgba(255,255,255,0.55)">Captured ${date} ${time} · SentraRMM simulated session</text>
  </g>
  ${card("HOSTNAME", o.hostname, cardY(342))}
  ${card("IPV4", o.ip, cardY(388))}
  ${card("UPTIME", fmtUptime(o.uptimeSec), cardY(434))}
  <g>
    <rect x="0" y="${H - 48}" width="${W}" height="48" fill="rgba(8,10,13,0.82)" stroke="rgba(255,255,255,0.08)"/>
    <rect x="24" y="${H - 36}" width="36" height="36" rx="9" fill="${a}" opacity="0.85"/>
    <rect x="33" y="${H - 27}" width="8" height="8" rx="2" fill="#0b0f12"/><rect x="43" y="${H - 27}" width="8" height="8" rx="2" fill="#0b0f12"/>
    <rect x="33" y="${H - 17}" width="8" height="8" rx="2" fill="#0b0f12"/><rect x="43" y="${H - 17}" width="8" height="8" rx="2" fill="#0b0f12"/>
    ${taskIcons}
    <text x="${W - 96}" y="${H - 24}" text-anchor="end" font-family="Segoe UI,Arial" font-size="16" fill="rgba(255,255,255,0.92)">${time}</text>
    <text x="${W - 96}" y="${H - 7}" text-anchor="end" font-family="Segoe UI,Arial" font-size="11" fill="rgba(255,255,255,0.60)">${date}</text>
  </g>
</svg>`;
}

export interface WebcamOpts {
  hostname: string;
  cameraId: string;
  cameraName: string;
  elapsedSec: number;
  now: Date;
  accent: string;
  /** warm palette tint per camera so camera:0 / camera:1 frames differ */
  variant: number;
}

/** NEW (v0.3): simulated webcam scene — warm-lit desk vignette + animated clock. */
export function svgWebcam(o: WebcamOpts): string {
  const W = 1280;
  const H = 720;
  const time = o.now.toTimeString().slice(0, 8);
  const date = o.now.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  const mm = String(Math.floor(o.elapsedSec / 60)).padStart(2, "0");
  const ss = String(Math.floor(o.elapsedSec % 60)).padStart(2, "0");
  const warm = o.variant === 1
    ? { a: "#3f2a12", b: "#7c4a1e", c: "#c2762a", glow: "#ffd9a0" }
    : { a: "#33200f", b: "#6b3d18", c: "#b45309", glow: "#ffe1b3" };
  // subtly animated pendulum/clock-hand angle from the elapsed seconds
  const tick = Math.floor(o.elapsedSec) % 60;
  const handAngle = (tick / 60) * 360;

  const deskItems = `
    <rect x="0" y="${H * 0.72}" width="${W}" height="${H * 0.28}" fill="${warm.b}" opacity="0.9"/>
    <rect x="0" y="${H * 0.72}" width="${W}" height="6" fill="rgba(255,255,255,0.14)"/>
    <g transform="translate(${W * 0.16} ${H * 0.4})">
      <rect x="-90" y="-52" width="260" height="160" rx="10" fill="rgba(18,14,10,0.92)" stroke="rgba(255,255,255,0.2)"/>
      <rect x="-78" y="-40" width="236" height="136" rx="6" fill="url(#screenGlow)"/>
      <text x="40" y="18" text-anchor="middle" font-family="Consolas,monospace" font-size="17" fill="rgba(255,240,214,0.9)">sentra@${o.hostname.toLowerCase()}</text>
      <text x="40" y="44" text-anchor="middle" font-family="Consolas,monospace" font-size="14" fill="rgba(255,240,214,0.55)">recording session active</text>
      <rect x="-30" y="108" width="140" height="14" rx="4" fill="rgba(18,14,10,0.92)"/>
    </g>
    <g transform="translate(${W * 0.52} ${H * 0.78})">
      <path d="M -34 0 L -30 -58 A 30 30 0 0 1 30 -58 L 34 0 Z" fill="${warm.c}" opacity="0.85"/>
      <ellipse cx="0" cy="-58" rx="30" ry="7" fill="rgba(255,255,255,0.25)"/>
      <path d="M 30 -50 q 26 4 18 26 q -6 14 -22 8" fill="none" stroke="${warm.c}" stroke-width="7" opacity="0.85"/>
      <ellipse cx="0" cy="0" rx="42" ry="8" fill="rgba(0,0,0,0.35)"/>
    </g>
    <g transform="translate(${W * 0.72} ${H * 0.62})">
      <rect x="-14" y="-70" width="28" height="66" rx="12" fill="rgba(240,234,222,0.85)"/>
      <rect x="-14" y="-70" width="28" height="22" rx="11" fill="rgba(120,90,60,0.9)"/>
      <circle cx="0" cy="-84" r="9" fill="rgba(240,234,222,0.7)"/>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="camWall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${warm.a}"/><stop offset="1" stop-color="${warm.b}"/>
    </linearGradient>
    <linearGradient id="screenGlow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${warm.glow}" stop-opacity="0.55"/><stop offset="1" stop-color="${warm.c}" stop-opacity="0.25"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.45" r="0.85">
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.55"/>
    </radialGradient>
    <filter id="warmBlur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="48"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#camWall)"/>
  <circle cx="${W * 0.85}" cy="${H * 0.2}" r="210" fill="${warm.glow}" opacity="0.30" filter="url(#warmBlur)"/>
  <circle cx="${W * 0.1}" cy="${H * 0.85}" r="170" fill="#000000" opacity="0.3" filter="url(#warmBlur)"/>
  ${deskItems}
  <g transform="translate(${W * 0.88} ${H * 0.2})">
    <circle r="56" fill="rgba(20,14,8,0.85)" stroke="rgba(255,255,255,0.25)" stroke-width="3"/>
    <line x1="0" y1="0" x2="0" y2="-38" stroke="${warm.glow}" stroke-width="4" stroke-linecap="round" transform="rotate(${handAngle})"/>
    <line x1="0" y1="0" x2="26" y2="0" stroke="rgba(255,255,255,0.8)" stroke-width="3" stroke-linecap="round"/>
    <circle r="4" fill="${warm.glow}"/>
  </g>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  <g>
    <circle cx="40" cy="40" r="10" fill="#ef4444"/>
    <text x="64" y="47" font-family="Consolas,monospace" font-size="22" fill="#fecaca">LIVE ${mm}:${ss}</text>
    <text x="${W - 36}" y="47" text-anchor="end" font-family="Segoe UI,Arial" font-size="18" fill="rgba(255,255,255,0.85)">${o.cameraName} (${o.cameraId})</text>
    <text x="${W / 2}" y="${H - 28}" text-anchor="middle" font-family="Segoe UI,Arial" font-size="14" fill="rgba(255,255,255,0.55)">SentraRMM simulated webcam · ${o.hostname} · ${date} ${time}</text>
  </g>
</svg>`;
}

export interface PosterOpts {
  hostname: string;
  kind: string;
  quality: string;
  assetId: string;
  elapsedSec: number;
  palette: [string, string, string];
  accent: string;
  camera: boolean;
  mic: boolean;
}

export function svgPoster(o: PosterOpts): string {
  const W = 1280;
  const H = 720;
  const [c1, c2, c3] = o.palette;
  const mm = String(Math.floor(o.elapsedSec / 60)).padStart(2, "0");
  const ss = String(Math.floor(o.elapsedSec % 60)).padStart(2, "0");

  const wavePts = Array.from({ length: 48 }, (_, i) => {
    const x = 320 + i * (640 / 47);
    const y = 330 + Math.sin(i * 0.9) * (18 + (i % 7) * 9);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const body = o.camera
    ? `<circle cx="640" cy="330" r="150" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="3"/>
    <circle cx="640" cy="330" r="112" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
    <circle cx="640" cy="330" r="52" fill="${o.accent}" opacity="0.35"/>
    <circle cx="600" cy="292" r="20" fill="rgba(255,255,255,0.35)"/>
    <text x="640" y="540" text-anchor="middle" font-family="Segoe UI,Arial" font-size="20" fill="rgba(255,255,255,0.7)" letter-spacing="4">LIVE CAMERA</text>`
    : o.mic
      ? `<rect x="300" y="240" width="680" height="180" rx="14" fill="rgba(255,255,255,0.05)"/>
    <polyline points="${wavePts}" fill="none" stroke="${o.accent}" stroke-width="2.5" stroke-linecap="round"/>
    <text x="640" y="500" text-anchor="middle" font-family="Segoe UI,Arial" font-size="20" fill="rgba(255,255,255,0.7)" letter-spacing="4">MIC CAPTURE</text>`
      : `<rect x="240" y="150" width="800" height="360" rx="14" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.15)"/>
    <text x="640" y="320" text-anchor="middle" font-family="Consolas,monospace" font-size="24" fill="rgba(255,255,255,0.55)">stream preview (simulated)</text>
    <text x="640" y="360" text-anchor="middle" font-family="Consolas,monospace" font-size="16" fill="rgba(255,255,255,0.35)">artifacts stay in memory · encrypted at rest</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="0.55" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#pg)"/>
  <circle cx="1080" cy="580" r="180" fill="#000000" opacity="0.25"/>
  <circle cx="120" cy="120" r="90" fill="${o.accent}" opacity="0.15"/>
  <circle cx="80" cy="76" r="10" fill="#ef4444"/>
  <text x="104" y="83" font-family="Consolas,monospace" font-size="22" fill="#fecaca">REC ${mm}:${ss}</text>
  <text x="640" y="83" text-anchor="middle" font-family="Segoe UI,Arial" font-size="18" fill="rgba(255,255,255,0.8)">SentraRMM — ${o.kind} · ${o.quality}</text>
  ${body}
  <text x="640" y="640" text-anchor="middle" font-family="Consolas,monospace" font-size="15" fill="rgba(255,255,255,0.45)">asset ${o.assetId} · ${o.hostname} · Sentra Agent v1.2.0</text>
</svg>`;
}
