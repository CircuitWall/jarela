import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { release } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import type { OwnedSkillProcess, SkillProcessOwner } from "./execution-runner";
import { probeSkillCgroup } from "./process-owner-cgroup";
import { launchLinuxSkill } from "./process-owner-linux";

type Launch = Parameters<SkillProcessOwner["launch"]>[0];
type Exit = Awaited<OwnedSkillProcess["completion"]>;

const STARTUP_MS = 15_000;
const CLEANUP_MS = 800;
// Next augments ProcessEnv with required NODE_ENV; brokers intentionally have none.
const BROKER_ENV = Object.freeze({}) as NodeJS.ProcessEnv;
const WINDOWS_SCRIPT = join(process.cwd(), "lib", "skills", "process-owner-windows.ps1");
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

export type SkillProcessOwnerAvailability =
  | { available: true; backend: "windows-job" | "linux-cgroup"; limitations: readonly string[] }
  | { available: false; reason: string };

/** Availability is a prerequisite check, not an execution grant or sandbox claim.
 * Job assignment / broker startup can still fail closed at launch.
 */
export function getSkillProcessOwnerAvailability(): SkillProcessOwnerAvailability {
  if (process.platform === "win32") {
    if (Number(release().split(".")[0]) < 10) {
      return { available: false, reason: "Atomic Job Object launch requires Windows 10 / Server 2016 or newer" };
    }
    if (!existsSync(POWERSHELL) || !existsSync(WINDOWS_SCRIPT)) {
      return { available: false, reason: "Windows PowerShell or trusted Job Object broker asset is unavailable" };
    }
    return {
      available: true, backend: "windows-job",
      limitations: [
        "Full-trust OS-user execution; a Job Object is process ownership, not a filesystem/network sandbox.",
        "Requires Windows 10 / Server 2016 or newer, Windows PowerShell with Add-Type, and permission to create/assign nested Job Objects; native startup failures fail closed.",
        "No user/app environment is inherited. Windows requires the OS-derived SystemRoot variable for Node/OpenSSL CSPRNG startup; a literally empty native environment is unsupported.",
      ],
    };
  }
  if (process.platform === "linux") {
    if (!existsSync(join(process.cwd(), "lib", "skills", "process-owner-linux.cjs")) || !probeSkillCgroup()) {
      return { available: false, reason: "Linux requires writable delegated cgroup-v2 controls (cgroup.kill/procs/events); configure canonical JARELA_SKILL_CGROUP_ROOT or delegate the app's self cgroup" };
    }
    return {
      available: true, backend: "linux-cgroup",
      limitations: [
        "Full-trust OS-user execution, not a filesystem/network sandbox.",
        "Requires writable delegated cgroup-v2 cgroup.kill/procs/events; setsid/setpgid do not escape this ownership.",
        "Drain verifies no live cgroup tasks (populated=0); orphan/zombie reaping remains the host init/service manager's responsibility.",
        "Same-user code with cgroup administration permissions can migrate itself outside the owned cgroup; this is not isolation from hostile OS-user code.",
        "App death triggers broker cleanup; broker death triggers app cleanup. Simultaneous app and broker death can leave descendants and cgroup directories for external service-manager cleanup.",
      ],
    };
  }
  if (process.platform === "darwin") {
    return {
      available: false,
      reason: "POSIX process groups cannot verify escaped descendants (setsid/setpgid) or guarantee cleanup after simultaneous app/broker death; no supported containment backend is installed",
    };
  }
  return { available: false, reason: "No checked-skill process ownership backend for this platform" };
}

function validate(input: Launch): Launch {
  if (input.executable !== process.execPath || !isAbsolute(input.cwd)
    || input.cwd.includes("\0") || Object.keys(input.env).length !== 0
    || typeof input.stdin !== "string" || !Array.isArray(input.args)
    || input.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Checked skills require exact Node executable, literal argv, absolute cwd and empty environment");
  }
  return { ...input, args: [...input.args], env: {} };
}

/**
 * Internal ownership adapter only. Does not authorize execution or enable any
 * production runner gate. A false cleanup result must retain staging.
 */
export function createSkillProcessOwner(): SkillProcessOwner {
  const availability = getSkillProcessOwnerAvailability();
  if (!availability.available) throw new Error(availability.reason);
  return { launch: (input) => availability.backend === "linux-cgroup" ? launchLinuxSkill(validate(input)) : launchOwned(validate(input)) };
}

function launchOwned(input: Launch): OwnedSkillProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let broker: ChildProcess | undefined;
  let socket: Socket | undefined;
  let stopping = false;
  let settled = false;
  let drainVerified = false;
  let stopPromise: Promise<boolean> | undefined;
  let resolveExit!: (exit: Exit) => void;
  let rejectExit!: (error: Error) => void;
  const completion = new Promise<Exit>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // Startup can fail before a caller attaches its completion handler.
  void completion.catch(() => {});
  const fail = () => {
    if (!settled) { settled = true; rejectExit(new Error("Skill process ownership broker failed")); }
  };
  const server = createServer();
  let timer: ReturnType<typeof setTimeout>;
  const closeServer = () => { if (server.listening) server.close(); };
  const finishStreams = () => { stdout.end(); stderr.end(); };
  const forceBroker = () => {
    if (!broker?.pid) return;
    try {
      broker.kill("SIGKILL");
    } catch { /* Missing process is checked separately, never assumed. */ }
  };
  const onMessage = (data: unknown) => {
    if (!data || typeof data !== "object") { fail(); forceBroker(); return; }
    const message = data as { kind?: string; exitCode?: number | null; signal?: string | null };
    if (message.kind === "ready") {
      clearTimeout(timer);
      if (stopping) {
        broker?.stdin?.end("stop\n");
      }
    } else if (message.kind === "exit" && !settled
      && (message.exitCode === null || Number.isInteger(message.exitCode))
      && (message.signal === null || typeof message.signal === "string")) {
      settled = true;
      resolveExit({ exitCode: message.exitCode!, signal: message.signal! });
    } else if (message.kind === "drained") {
      drainVerified = true;
    } else if (message.kind === "error") {
      fail();
    }
  };
  const attach = (child: ChildProcess) => {
    broker = child;
    child.stdout!.pipe(stdout);
    child.stderr!.pipe(stderr);
    child.stdin?.on("error", () => {});
    child.once("error", () => { fail(); clearTimeout(timer); closeServer(); finishStreams(); });
    child.once("exit", () => {
      clearTimeout(timer);
      closeServer();
      fail();
    });
    child.once("close", finishStreams);
  };
  timer = setTimeout(() => {
    fail(); forceBroker(); socket?.destroy(); closeServer();
  }, STARTUP_MS);
  {
    const pipe = `\\\\.\\pipe\\jarela-skill-${randomBytes(24).toString("hex")}`;
    // Never accept control on stdout/stderr: script output is untrusted bytes.
    server.on("connection", (connection) => {
      if (socket) { connection.destroy(); return; }
      socket = connection;
      closeServer();
      let pending = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk: string) => {
        pending += chunk;
        if (pending.length > 4096) { fail(); forceBroker(); connection.destroy(); return; }
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try { onMessage(JSON.parse(line)); }
          catch { fail(); forceBroker(); connection.destroy(); }
        }
      });
      connection.on("error", fail);
      connection.on("close", () => {
        if (!drainVerified) { fail(); forceBroker(); }
      });
    });
    server.once("error", () => { fail(); clearTimeout(timer); finishStreams(); });
    server.listen(pipe, () => {
      if (stopping) { clearTimeout(timer); closeServer(); finishStreams(); fail(); return; }
      attach(spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_SCRIPT], {
        env: BROKER_ENV, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      }));
      broker!.stdin!.write(JSON.stringify({
        executable: input.executable, args: input.args, cwd: input.cwd,
        stdinBase64: Buffer.from(input.stdin, "utf8").toString("base64"), pipe: pipe.slice("\\\\.\\pipe\\".length),
      }) + "\n");
    });
  }

  return {
    stdout, stderr, completion,
    stopAndVerifyTree() {
      return stopPromise ??= (async () => {
        stopping = true;
        clearTimeout(timer);
        const deadline = performance.now() + CLEANUP_MS;
        if (!broker) {
          closeServer(); finishStreams(); fail();
          return true; // Windows listen callback cannot spawn after stopping.
        }
        broker.stdin?.end("stop\n");
        while (performance.now() < deadline) {
          if (drainVerified) {
            socket?.destroy(); closeServer();
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        forceBroker(); socket?.destroy(); closeServer();
        return false;
      })();
    },
  };
}
