"use strict";
// Trusted broker only. Invocation data is IPC, never executable command text.
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
let directory;
const die = () => {
  if (directory) {
    try { fs.writeFileSync(path.join(directory, "cgroup.kill"), "1"); } catch { }
  }
  process.exit(1);
};
process.on("disconnect", die);
process.once("message", (input) => {
  try {
    directory = input.group;
    // The broker itself enters first. All subsequent descendants inherit this
    // cgroup even when they start a new POSIX session/process group.
    fs.writeFileSync(path.join(directory, "cgroup.procs"), String(process.pid));
    if (!process.connected) die();
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd, env: {}, shell: false, stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.on("error", () => {});
    child.once("error", () => { if (process.connected) process.send({ kind: "error" }); });
    child.once("spawn", () => {
      fs.closeSync(1); fs.closeSync(2);
      if (process.connected) process.send({ kind: "ready" });
      else die();
    });
    child.once("exit", (exitCode, signal) => {
      if (process.connected) process.send({ kind: "exit", exitCode, signal });
      else die();
    });
    child.stdin.end(input.stdin, "utf8");
  } catch {
    if (process.connected) process.send({ kind: "error" });
    else die();
  }
});
