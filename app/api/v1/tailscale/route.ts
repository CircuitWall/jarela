import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "@/lib/env/config";

// Surface Tailscale serve status so the Profile panel can show whether the
// installed Jarela is reachable on the tailnet. The endpoint is loopback-only
// (the standard same-origin guard already applies); it shells out to the
// `tailscale` CLI rather than reading any local config so the answer is
// always up-to-date.

interface TailscaleStatus {
  installed: boolean;
  logged_in: boolean;
  fqdn: string | null;
  serving: boolean;
  serve_recipe: string;
  install_script: string;
  uninstall_script: string;
}

function findTailscale(): string | null {
  // Prefer PATH; fall back to the default Windows install location.
  const onPath = process.platform === "win32" ? "tailscale.exe" : "tailscale";
  const candidates = process.platform === "win32"
    ? [
        join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Tailscale", "tailscale.exe"),
        join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Tailscale", "tailscale.exe"),
      ]
    : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return onPath;
}

function runTailscale(bin: string, args: string[], timeoutMs = 3000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    const finish = (code: number) => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout?.on("data", (b) => { stdout += b.toString(); });
    child.stderr?.on("data", (b) => { stderr += b.toString(); });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(-1);
    }, timeoutMs);
  });
}

export async function GET(): Promise<NextResponse<TailscaleStatus>> {
  const bin = findTailscale();
  const { port } = getConfig();
  const recipe = `tailscale serve --bg http://localhost:${port}`;
  const installScript = "scripts/install-tailscale-serve.ps1";
  const uninstallScript = "scripts/uninstall-tailscale-serve.ps1";

  const empty: TailscaleStatus = {
    installed: false,
    logged_in: false,
    fqdn: null,
    serving: false,
    serve_recipe: recipe,
    install_script: installScript,
    uninstall_script: uninstallScript,
  };

  if (!bin) return NextResponse.json(empty);

  // Probe `tailscale status --json` for the FQDN. Short timeout — the
  // daemon may be down on dev machines.
  const status = await runTailscale(bin, ["status", "--json"]);
  if (status.code !== 0 || !status.stdout) {
    return NextResponse.json({ ...empty, installed: true });
  }

  let fqdn: string | null = null;
  let loggedIn = false;
  try {
    const parsed = JSON.parse(status.stdout) as { Self?: { DNSName?: string; Online?: boolean } };
    if (parsed.Self?.DNSName) {
      fqdn = parsed.Self.DNSName.replace(/\.$/, "");
      loggedIn = true;
    }
  } catch { /* ignore */ }

  // Probe `tailscale serve status` for any active forward to our port.
  let serving = false;
  const serveStatus = await runTailscale(bin, ["serve", "status"]);
  if (serveStatus.code === 0 && serveStatus.stdout) {
    serving = /localhost:\s*\d+/i.test(serveStatus.stdout) && serveStatus.stdout.includes(String(port));
  }

  return NextResponse.json({
    installed: true,
    logged_in: loggedIn,
    fqdn,
    serving,
    serve_recipe: recipe,
    install_script: installScript,
    uninstall_script: uninstallScript,
  });
}
