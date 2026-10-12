// The three simulated Windows devices. `profile` tweaks the virtual
// filesystem, process table, exec output and screenshot wallpaper.
// v0.3: every sim reports CaptureCapabilities at register time.

import type { AgentInfo, CaptureCapabilities, DeviceType } from "../../../src/lib/types";

export type DeviceProfile = "work" | "home" | "server";

export interface SpawnSeed {
  name: string;
  user: "SYSTEM" | "USER";
  path: string;
  memMB: number;
}

export interface DeviceDef {
  profile: DeviceProfile;
  info: AgentInfo;
  /** v0.3 capture capabilities reported in agent:register */
  captures: CaptureCapabilities;
  userName: string;
  osBuild: string;
  cpuMhz: number;
  sysManufacturer: string;
  sysModel: string;
  biosVersion: string;
  nicDescription: string;
  cpuBase: number;
  cpuSpread: number;
  memBase: number;
  memSpread: number;
  diskPercent: number;
  netUpBase: number;
  netUpSpread: number;
  netDownBase: number;
  netDownSpread: number;
  activeUsers: [number, ...number[]];
  bootDaysAgo: number;
  palette: [string, string, string];
  accent: string;
  location: { lat: number; lon: number; label: string };
  volumes: { letter: string; label: string; sizeGb: number }[];
  spawnPool: SpawnSeed[];
}

const WORK: DeviceDef = {
  profile: "work",
  info: {
    agentId: "SIM-WKS-001",
    hostname: "SENTRA-WORKSTATION",
    friendlyName: "Office Workstation",
    osName: "Windows 11 Pro",
    osVersion: "23H2 (Build 22631)",
    osArch: "x64",
    platform: "win32",
    cpuModel: "11th Gen Intel(R) Core(TM) i7-11700 @ 2.50GHz",
    cpuCores: 8,
    totalMemoryMB: 32736,
    localIp: "192.168.1.50",
    macAddress: "A4:BB:6D:3E:91:C7",
    agentVersion: "1.2.0",
    deviceType: "workstation" as DeviceType,
    tags: ["work", "red-team"],
  },
  captures: {
    monitors: [
      { id: "monitor:0", name: "Display 1 (primary)", width: 1920, height: 1080, primary: true },
      { id: "monitor:1", name: "Display 2", width: 2560, height: 1440, primary: false },
    ],
    cameras: [
      { id: "camera:0", name: "Integrated Webcam" },
      { id: "camera:1", name: "USB Capture Device" },
    ],
    mics: [
      { id: "mic:0", name: "Microphone Array (Realtek)" },
      { id: "mic:1", name: "USB Microphone" },
    ],
    shells: ["powershell", "cmd"],
    notes: ["Simulated device — synthetic capture sources"],
  },
  userName: "tmasuku",
  osBuild: "10.0.22631.4460",
  cpuMhz: 2500,
  sysManufacturer: "Dell Inc.",
  sysModel: "OptiPlex 7090",
  biosVersion: "Dell Inc. 1.24.0, 8/19/2024",
  nicDescription: "Intel(R) Ethernet Connection (14) I219-LM",
  cpuBase: 22,
  cpuSpread: 14,
  memBase: 56,
  memSpread: 7,
  diskPercent: 62,
  netUpBase: 220,
  netUpSpread: 160,
  netDownBase: 1350,
  netDownSpread: 950,
  activeUsers: [1, 2],
  bootDaysAgo: 9,
  palette: ["#04231d", "#0b5c4a", "#15803d"],
  accent: "#2dd4bf",
  location: { lat: -26.3187, lon: 31.1367, label: "Mbabane, Hhohho, SZ" },
  volumes: [{ letter: "C", label: "OS", sizeGb: 475.94 }],
  spawnPool: [
    { name: "notepad.exe", user: "USER", path: "C:\\Windows\\System32\\notepad.exe", memMB: 14 },
    { name: "cmd.exe", user: "USER", path: "C:\\Windows\\system32\\cmd.exe", memMB: 6 },
    { name: "chrome.exe", user: "USER", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", memMB: 310 },
    { name: "SnippingTool.exe", user: "USER", path: "C:\\Windows\\System32\\SnippingTool.exe", memMB: 18 },
    { name: "conhost.exe", user: "USER", path: "C:\\Windows\\system32\\conhost.exe", memMB: 10 },
    { name: "msedge.exe", user: "USER", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", memMB: 240 },
  ],
};

const HOME: DeviceDef = {
  profile: "home",
  info: {
    agentId: "SIM-HOME-002",
    hostname: "HOME-DESKTOP",
    friendlyName: "Home Desktop",
    osName: "Windows 10 Pro",
    osVersion: "22H2 (Build 19045)",
    osArch: "x64",
    platform: "win32",
    cpuModel: "AMD Ryzen 5 5600X 6-Core",
    cpuCores: 6,
    totalMemoryMB: 16384,
    localIp: "192.168.1.64",
    macAddress: "F0:2F:74:8A:22:E1",
    agentVersion: "1.2.0",
    deviceType: "workstation" as DeviceType,
    tags: ["home"],
  },
  captures: {
    monitors: [
      { id: "monitor:0", name: "Display 1 (primary)", width: 1920, height: 1080, primary: true },
      { id: "monitor:1", name: "Display 2", width: 2560, height: 1440, primary: false },
    ],
    cameras: [
      { id: "camera:0", name: "Integrated Webcam" },
      { id: "camera:1", name: "USB Capture Device" },
    ],
    mics: [
      { id: "mic:0", name: "Microphone Array (Realtek)" },
      { id: "mic:1", name: "USB Microphone" },
    ],
    shells: ["powershell", "cmd"],
    notes: ["Simulated device — synthetic capture sources"],
  },
  userName: "home",
  osBuild: "10.0.19045.5011",
  cpuMhz: 3700,
  sysManufacturer: "ASUSTeK COMPUTER INC.",
  sysModel: "System Product Name",
  biosVersion: "American Megatrends Inc. 3607, 5/12/2023",
  nicDescription: "Realtek PCIe GbE Family Controller",
  cpuBase: 12,
  cpuSpread: 9,
  memBase: 44,
  memSpread: 8,
  diskPercent: 71,
  netUpBase: 70,
  netUpSpread: 50,
  netDownBase: 900,
  netDownSpread: 700,
  activeUsers: [1],
  bootDaysAgo: 23,
  palette: ["#2a0a15", "#7f1d1d", "#b45309"],
  accent: "#fb923c",
  location: { lat: -26.3, lon: 31.18, label: "Ezulwini Valley, SZ" },
  volumes: [{ letter: "C", label: "OS", sizeGb: 931.51 }],
  spawnPool: [
    { name: "notepad.exe", user: "USER", path: "C:\\Windows\\System32\\notepad.exe", memMB: 12 },
    { name: "cmd.exe", user: "USER", path: "C:\\Windows\\system32\\cmd.exe", memMB: 6 },
    { name: "chrome.exe", user: "USER", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", memMB: 280 },
    { name: "conhost.exe", user: "USER", path: "C:\\Windows\\system32\\conhost.exe", memMB: 10 },
    { name: "CalculatorApp.exe", user: "USER", path: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2210.0.0\\CalculatorApp.exe", memMB: 46 },
  ],
};

const SERVER: DeviceDef = {
  profile: "server",
  info: {
    agentId: "SIM-SRV-003",
    hostname: "LAB-SRV-01",
    friendlyName: "Assessment Lab Server",
    osName: "Windows Server 2022 Standard",
    osVersion: "21H2 (Build 20348)",
    osArch: "x64",
    platform: "win32",
    cpuModel: "Intel(R) Xeon(R) Silver 4310",
    cpuCores: 16,
    totalMemoryMB: 65536,
    localIp: "192.168.1.10",
    macAddress: "3C:EC:EF:11:57:0A",
    agentVersion: "1.2.0",
    deviceType: "server" as DeviceType,
    tags: ["lab", "blue-team"],
  },
  captures: {
    monitors: [
      { id: "monitor:0", name: "Display 1 (primary)", width: 1920, height: 1080, primary: true },
      { id: "monitor:1", name: "Display 2", width: 2560, height: 1440, primary: false },
    ],
    cameras: [
      { id: "camera:0", name: "Integrated Webcam" },
      { id: "camera:1", name: "USB Capture Device" },
    ],
    mics: [
      { id: "mic:0", name: "Microphone Array (Realtek)" },
      { id: "mic:1", name: "USB Microphone" },
    ],
    shells: ["powershell", "cmd"],
    notes: ["Simulated device — synthetic capture sources"],
  },
  userName: "Administrator",
  osBuild: "10.0.20348.2849",
  cpuMhz: 2100,
  sysManufacturer: "Dell Inc.",
  sysModel: "PowerEdge R650",
  biosVersion: "Dell Inc. 2.10.2, 3/4/2024",
  nicDescription: "Broadcom BCM57416 NetXtreme-E Gigabit Ethernet",
  cpuBase: 34,
  cpuSpread: 16,
  memBase: 63,
  memSpread: 6,
  diskPercent: 47,
  netUpBase: 420,
  netUpSpread: 300,
  netDownBase: 2100,
  netDownSpread: 1400,
  activeUsers: [1, 2],
  bootDaysAgo: 41,
  palette: ["#0a0f14", "#123a36", "#1f5148"],
  accent: "#34d399",
  location: { lat: -26.49, lon: 31.38, label: "Manzini, SZ" },
  volumes: [
    { letter: "C", label: "OS", sizeGb: 2047.81 },
    { letter: "D", label: "Data", sizeGb: 3725.99 },
  ],
  spawnPool: [
    { name: "python.exe", user: "USER", path: "C:\\Program Files\\Python312\\python.exe", memMB: 96 },
    { name: "cmd.exe", user: "USER", path: "C:\\Windows\\system32\\cmd.exe", memMB: 6 },
    { name: "conhost.exe", user: "USER", path: "C:\\Windows\\system32\\conhost.exe", memMB: 10 },
    { name: "vmwp.exe", user: "SYSTEM", path: "C:\\Program Files\\Hyper-V\\vmwp.exe", memMB: 380 },
    { name: "wsmprovhost.exe", user: "USER", path: "C:\\Windows\\system32\\wsmprovhost.exe", memMB: 42 },
  ],
};

export const SIM_DEVICE_DEFS: DeviceDef[] = [WORK, HOME, SERVER];
