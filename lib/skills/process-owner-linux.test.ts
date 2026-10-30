import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { spawn } from "node:child_process";
import { createSkillCgroup } from "./process-owner-cgroup";
import { launchLinuxSkill } from "./process-owner-linux";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./process-owner-cgroup", () => ({ createSkillCgroup: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("Linux cgroup broker and owner", () => {
  it("joins the cgroup before spawning any user code and kills on app IPC loss", () => {
    const source = readFileSync(join(process.cwd(), "lib", "skills", "process-owner-linux.cjs"), "utf8");
    const processFixture = Object.assign(new EventEmitter(), { pid: 321, connected: true, exit: vi.fn(), send: vi.fn() });
    const order: string[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }) });
    runInNewContext(source, {
      process: processFixture,
      require(name: string) {
        if (name === "node:fs") return { writeFileSync: (path: string) => order.push(path), closeSync: vi.fn() };
        if (name === "node:path") return { join };
        if (name === "node:child_process") return { spawn: () => { order.push("spawn"); return child; } };
        throw new Error("Unexpected broker dependency");
      },
    });
    processFixture.emit("message", { group: "owned", executable: process.execPath, args: [], cwd: process.cwd(), stdin: "" });
    expect(order).toEqual([join("owned", "cgroup.procs"), "spawn"]);
    processFixture.emit("disconnect");
    expect(order.at(-1)).toBe(join("owned", "cgroup.kill"));
    expect(processFixture.exit).toHaveBeenCalledWith(1);
  });

  it("never launches user code if entering the delegated cgroup is denied", () => {
    const source = readFileSync(join(process.cwd(), "lib", "skills", "process-owner-linux.cjs"), "utf8");
    const processFixture = Object.assign(new EventEmitter(), { pid: 321, connected: true, exit: vi.fn(), send: vi.fn() });
    const spawnFixture = vi.fn();
    runInNewContext(source, {
      process: processFixture,
      require(name: string) {
        if (name === "node:fs") return { writeFileSync: () => { throw new Error("Permission denied"); } };
        if (name === "node:path") return { join };
        if (name === "node:child_process") return { spawn: spawnFixture };
        throw new Error("Unexpected broker dependency");
      },
    });
    processFixture.emit("message", { group: "owned" });
    expect(spawnFixture).not.toHaveBeenCalled();
    expect(processFixture.send).toHaveBeenCalledWith({ kind: "error" });
  });

  for (const populated of [false, true]) {
    it(`requires broker exit and populated0 before cleanup success (populated=${populated})`, async () => {
      const broker = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
        send: vi.fn(), kill: vi.fn(),
      });
      broker.kill.mockImplementation(() => { queueMicrotask(() => broker.emit("exit", null, "SIGKILL")); return true; });
      const group = { directory: "owned", kill: vi.fn(), populated: vi.fn(() => populated), remove: vi.fn() };
      vi.mocked(createSkillCgroup).mockReturnValue(group);
      vi.mocked(spawn).mockReturnValue(broker as never);
      const child = launchLinuxSkill({ executable: process.execPath, args: [], cwd: process.cwd(), stdin: "", env: {} });
      const result = await child.stopAndVerifyTree();
      expect(result).toBe(!populated);
      expect(group.kill).toHaveBeenCalledOnce();
      expect(group.remove).toHaveBeenCalledTimes(populated ? 0 : 1);
      expect(await child.stopAndVerifyTree()).toBe(result);
    }, 5000);
  }
});
