// Simulated Windows process table. Persists between requests: ps:action
// kill/suspend/resume mutates the stored list, and it slowly churns over time
// (services restart, browser tabs open/close) like a real machine would.

import type { ProcessInfo } from "../../../src/lib/types";
import { clamp, jitter, pick, rnd, rndInt, round1 } from "../util";
import type { DeviceDef, SpawnSeed } from "./devices";

export class ProcTable {
  private procs: ProcessInfo[] = [];
  private nextPid: number;

  constructor(private def: DeviceDef) {
    this.nextPid = rndInt(600, 1200);
    this.spawnBase();
  }

  private add(name: string, user: string, path: string, memMB: number, pid?: number): void {
    this.procs.push({
      pid: pid ?? this.nextPid,
      name,
      cpuPercent: 0,
      memoryMB: round1(memMB),
      status: "running",
      user,
      path,
    });
    if (pid === undefined) this.nextPid += rndInt(4, 48);
  }

  private spawnBase(): void {
    const d = this.def;
    const u = d.userName;
    const S = "SYSTEM";
    const sys32 = "C:\\Windows\\System32";
    this.add("System", S, "C:\\Windows\\system32\\ntoskrnl.exe", 0.1, 4);
    this.add("Registry", S, "", rnd(10, 22), 136);
    this.add("smss.exe", S, `${sys32}\\smss.exe`, 1.2);
    for (let i = 0; i < 2; i++) this.add("csrss.exe", S, "C:\\Windows\\system32\\csrss.exe", rnd(3.5, 6));
    this.add("wininit.exe", S, `${sys32}\\wininit.exe`, 2.9);
    this.add("winlogon.exe", S, `${sys32}\\winlogon.exe`, 6.8);
    this.add("services.exe", S, `${sys32}\\services.exe`, 10.4);
    this.add("lsass.exe", S, `${sys32}\\lsass.exe`, 14.7);
    for (let i = 0; i < 6; i++) this.add("svchost.exe", S, "C:\\Windows\\system32\\svchost.exe", rnd(24, 180));
    this.add("dwm.exe", u, `${sys32}\\dwm.exe`, rnd(58, 96));
    this.add("fontdrvhost.exe", S, "C:\\Windows\\system32\\fontdrvhost.exe", 1.4);
    this.add("explorer.exe", u, "C:\\Windows\\explorer.exe", rnd(120, 210));
    for (let i = 0; i < 2; i++) this.add("RuntimeBroker.exe", u, `${sys32}\\RuntimeBroker.exe`, rnd(18, 40));
    this.add("SearchHost.exe", u, "C:\\Windows\\SystemApps\\Microsoft.Windows.Search_cw5n1h2txyewy\\SearchHost.exe", 121);
    this.add("MsMpEng.exe", S, "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.24110.5-0\\MsMpEng.exe", rnd(180, 320));
    this.add("spoolsv.exe", S, `${sys32}\\spoolsv.exe`, 9.6);

    if (d.profile === "work" || d.profile === "home") {
      this.add("SecurityHealthService.exe", S, `${sys32}\\SecurityHealthService.exe`, 12.4);
      this.add("SecurityHealthSystray.exe", u, `${sys32}\\SecurityHealthSystray.exe`, 3.2);
      this.add("OneDrive.exe", u, `C:\\Users\\${u}\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe`, rnd(70, 130));
      for (let i = 0; i < 3; i++) this.add("chrome.exe", u, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", rnd(180, 820));
      for (let i = 0; i < 2; i++) this.add("msedge.exe", u, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", rnd(140, 380));
      this.add("Code.exe", u, `C:\\Users\\${u}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe`, rnd(320, 760));
      this.add("Teams.exe", u, `C:\\Users\\${u}\\AppData\\Local\\Microsoft\\Teams\\current\\Teams.exe`, rnd(240, 540));
      this.add("powershell.exe", u, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", 96);
      if (d.profile === "home") {
        this.add("Discord.exe", u, `C:\\Users\\${u}\\AppData\\Local\\Discord\\app-1.4.16\\Discord.exe`, rnd(180, 420));
      }
    } else {
      for (let i = 0; i < 2; i++) this.add("python.exe", u, "C:\\Program Files\\Python312\\python.exe", rnd(60, 300));
      this.add("sshd.exe", S, "C:\\Windows\\System32\\OpenSSH\\sshd.exe", 12.8);
      this.add("vmms.exe", S, "C:\\Program Files\\Hyper-V\\vmms.exe", rnd(80, 160));
      this.add("wlms.exe", S, "C:\\Windows\\system32\\wlms\\wlms.exe", 4.1);
      this.add("dfssvc.exe", S, `${sys32}\\dfssvc.exe`, 3.4);
    }
  }

  /** Fresh jittered snapshot (does not mutate the stored rows). */
  list(): ProcessInfo[] {
    this.regenTick();
    return this.procs.map((p) => ({
      ...p,
      cpuPercent: p.status === "running" ? this.cpuFor(p) : 0,
      memoryMB: round1(clamp(jitter(p.memoryMB, Math.max(1, p.memoryMB * 0.12)), 0.1, 8192)),
    }));
  }

  private cpuFor(p: ProcessInfo): number {
    const hot = /chrome|msedge|code|teams|msmpeng|python|searchhost/i.test(p.name);
    const roll = Math.random();
    if (roll < 0.55) return round1(rnd(0.2, 6));
    if (roll < 0.9) return round1(rnd(6, 24));
    return round1(rnd(24, hot ? 62 : 28));
  }

  /** Occasionally spawn or close user-level processes so the list churns. */
  private regenTick(): void {
    if (Math.random() < 0.12 && this.procs.length < 40) {
      const seed = pick(this.def.spawnPool) as SpawnSeed;
      const same = this.procs.filter((p) => p.name === seed.name).length;
      if (same < 5) {
        this.add(seed.name, seed.user === "SYSTEM" ? "SYSTEM" : this.def.userName, seed.path, seed.memMB * rnd(0.8, 1.25));
      }
    }
    if (Math.random() < 0.08) {
      const extras = this.procs.filter((p) => /chrome|msedge/i.test(p.name));
      if (extras.length > 5) {
        const victim = pick(extras);
        this.procs = this.procs.filter((p) => p.pid !== victim.pid);
      }
    }
  }

  action(pid: number, action: string): { ok: true } {
    const p = this.procs.find((x) => x.pid === pid);
    if (!p) throw new Error(`Process not found: ${pid}`);
    if (p.pid === 4 && action === "kill") {
      throw new Error("Access denied. Unable to terminate a critical system process.");
    }
    if (action === "kill") {
      this.procs = this.procs.filter((x) => x.pid !== pid);
    } else if (action === "suspend") {
      p.status = "suspended";
    } else if (action === "resume") {
      p.status = "running";
    } else {
      throw new Error(`Unknown action '${action}'`);
    }
    return { ok: true };
  }
}
