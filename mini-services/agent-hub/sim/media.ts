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
}

export function svgDesktop(o: DesktopOpts): string {
  const W = 1600;
  const H = 900;
  // seconds precision → every live-view frame renders a unique clock
  const time = o.now.toTimeString().slice(0, 8);
  const netUp = o.netUpKBps >= 1024 ? `${(o.netUpKBps / 1024).toFixed(1)} MB/s` : `${Math.round(o.netUpKBps)} KB/s`;
  const netDown = o.netDownKBps >= 1024 ? `${(o.netDownKBps / 1024).toFixed(1)} MB/s` : `${Math.round(o.netDownKBps)} KB/s`;
  const date = o.now.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  const [c1, c2, c3] = o.palette;
  const a = o.accent;

  const barW = 560;
  const mkBar = (label: string, v: number, y: number): string => {
    const bw = Math.round((Math.min(100, Math.max(0, v)) / 100) * barW);
    return `<text x="400" y="${y + 18}" font-family="Segoe UI,Arial" font-size="15" fill="#e8f6f2" opacity="0.85">${label}</text>
    <rect x="460" y="${y}" width="${barW}" height="22" rx="11" fill="rgba(255,255,255,0.10)"/>
    <rect x="460" y="${y}" width="${bw}" height="22" rx="11" fill="url(#barGrad)"/>
    <text x="1036" y="${y + 18}" font-family="Segoe UI,Arial" font-size="15" fill="#e8f6f2">${Math.round(v)}%</text>`;
  };

  const hist = o.cpuHistory.length >= 2 ? o.cpuHistory.slice(-32) : [o.cpu || 12, o.cpu || 12];
  const sx = 400;
  const sy = 452;
  const sw = 560;
  const sh = 130;
  const step = sw / Math.max(1, hist.length - 1);
  const pts = hist
    .map((v, i) => `${(sx + i * step).toFixed(1)},${(sy + sh - (Math.min(100, Math.max(0, v)) / 100) * sh).toFixed(1)}`)
    .join(" ");

  const iconLabels = ["This PC", "Recycle Bin", "Sentra Agent", "Documents"];
  const icons = iconLabels
    .map(
      (label, i) => `<g transform="translate(48 ${64 + i * 108})">
      <rect width="56" height="56" rx="12" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.25)"/>
      <rect x="14" y="18" width="28" height="20" rx="4" fill="rgba(255,255,255,0.55)"/>
      <text x="28" y="82" text-anchor="middle" font-family="Segoe UI,Arial" font-size="13" fill="rgba(255,255,255,0.92)">${label}</text>
    </g>`,
    )
    .join("\n  ");

  const taskIcons = [0, 1, 2, 3, 4]
    .map((i) => `<rect x="${86 + i * 52}" y="864" width="36" height="36" rx="9" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.16)"/>`)
    .join("\n    ");

  const card = (label: string, value: string, y: number): string =>
    `<rect x="990" y="${y}" width="240" height="38" rx="8" fill="rgba(255,255,255,0.06)"/>
    <text x="1002" y="${y + 15}" font-family="Segoe UI,Arial" font-size="10" fill="rgba(255,255,255,0.5)" letter-spacing="1.5">${label}</text>
    <text x="1002" y="${y + 31}" font-family="Segoe UI,Arial" font-size="13" fill="rgba(255,255,255,0.9)">${value}</text>`;

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
  <circle cx="1250" cy="150" r="240" fill="${a}" opacity="0.20" filter="url(#blur60)"/>
  <circle cx="300" cy="740" r="220" fill="#000000" opacity="0.18" filter="url(#blur60)"/>
  <circle cx="760" cy="420" r="320" fill="#ffffff" opacity="0.05" filter="url(#blur60)"/>
  ${icons}
  <g>
    <rect x="360" y="110" width="900" height="620" rx="16" fill="rgba(13,18,22,0.84)" stroke="rgba(255,255,255,0.16)"/>
    <rect x="360" y="110" width="900" height="44" rx="16" fill="rgba(255,255,255,0.06)"/>
    <rect x="360" y="138" width="900" height="16" fill="rgba(255,255,255,0.06)"/>
    <circle cx="1222" cy="132" r="7" fill="#f87171"/><circle cx="1198" cy="132" r="7" fill="#fbbf24"/><circle cx="1174" cy="132" r="7" fill="#34d399"/>
    <text x="810" y="138" text-anchor="middle" font-family="Segoe UI,Arial" font-size="15" fill="rgba(255,255,255,0.88)">Sentra Agent — ${o.hostname}</text>
    <text x="396" y="200" font-family="Segoe UI,Arial" font-size="13" fill="${a}" letter-spacing="2">SYSTEM MONITOR</text>
    <text x="396" y="226" font-family="Segoe UI,Arial" font-size="14" fill="rgba(255,255,255,0.65)">${o.osLabel} · ${o.ip} · agent v${o.agentVersion} · uptime ${fmtUptime(o.uptimeSec)}</text>
    ${mkBar("CPU", o.cpu, 268)}
    ${mkBar("RAM", o.mem, 312)}
    ${mkBar("DISK", o.disk, 356)}
    <text x="400" y="412" font-family="Segoe UI,Arial" font-size="15" fill="#e8f6f2" opacity="0.85">NET</text>
    <text x="460" y="412" font-family="Consolas,monospace" font-size="15" fill="#7ef0cf">↑ ${netUp}</text>
    <text x="640" y="412" font-family="Consolas,monospace" font-size="15" fill="#7ec8f0">↓ ${netDown}</text>
    <text x="396" y="432" font-family="Segoe UI,Arial" font-size="13" fill="rgba(255,255,255,0.65)" letter-spacing="2">CPU — LAST ${hist.length} SAMPLES</text>
    <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="10" fill="rgba(255,255,255,0.05)"/>
    <line x1="${sx}" y1="${sy + sh}" x2="${sx + sw}" y2="${sy + sh}" stroke="rgba(255,255,255,0.15)"/>
    <polyline points="${pts}" fill="none" stroke="${a}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${card("HOSTNAME", o.hostname, 452)}
    ${card("IPV4", o.ip, 498)}
    ${card("UPTIME", fmtUptime(o.uptimeSec), 544)}
    <text x="396" y="636" font-family="Segoe UI,Arial" font-size="13" fill="rgba(255,255,255,0.55)">Captured ${date} ${time} · SentraRMM simulated session</text>
  </g>
  <g>
    <rect x="0" y="${H - 48}" width="${W}" height="48" fill="rgba(8,10,13,0.82)" stroke="rgba(255,255,255,0.08)"/>
    <rect x="24" y="864" width="36" height="36" rx="9" fill="${a}" opacity="0.85"/>
    <rect x="33" y="873" width="8" height="8" rx="2" fill="#0b0f12"/><rect x="43" y="873" width="8" height="8" rx="2" fill="#0b0f12"/>
    <rect x="33" y="883" width="8" height="8" rx="2" fill="#0b0f12"/><rect x="43" y="883" width="8" height="8" rx="2" fill="#0b0f12"/>
    ${taskIcons}
    <text x="1504" y="876" text-anchor="end" font-family="Segoe UI,Arial" font-size="16" fill="rgba(255,255,255,0.92)">${time}</text>
    <text x="1504" y="893" text-anchor="end" font-family="Segoe UI,Arial" font-size="11" fill="rgba(255,255,255,0.60)">${date}</text>
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
