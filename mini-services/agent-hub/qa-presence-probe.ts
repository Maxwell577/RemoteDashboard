// QA probe: connects a temporary agent to the hub, registers, then
// disconnects — used to verify the dashboard presence toasts pipeline.
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:3003", { path: "/", reconnection: false });

socket.on("connect", () => {
  socket.emit(
    "agent:register",
    {
      info: {
        agentId: "SIM-QA-999",
        hostname: "QA-PROBE-01",
        friendlyName: "QA Presence Probe",
        osName: "Windows 10 Pro",
        osVersion: "22H2",
        osArch: "x64",
        platform: "win32",
        cpuModel: "QA Probe CPU",
        cpuCores: 4,
        totalMemoryMB: 8192,
        localIp: "192.168.1.99",
        macAddress: "00:00:5E:00:53:99",
        agentVersion: "1.2.0",
        deviceType: "workstation",
        tags: ["lab"],
      },
    },
    (ack?: { ok?: boolean }) => {
      console.log("registered:", ack?.ok);
      // stay online briefly so the dashboard observes the transition,
      // then disconnect → hub emits device:update offline + warning alert
      setTimeout(() => {
        socket.disconnect();
        console.log("disconnected");
        setTimeout(() => process.exit(0), 500);
      }, 4000);
    },
  );
});

socket.on("connect_error", (e: Error) => {
  console.error("connect_error:", e.message);
  process.exit(1);
});
