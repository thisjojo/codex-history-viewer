// Start the Vite dev server on a port that is actually available, then launch the Tauri
// desktop app pointed at it.
//
// Why this exists: on Windows a large block of TCP ports can be reserved by the OS
// (`netsh int ipv4 show excludedportrange protocol=tcp` — 1353-1452 on the reference
// machine). The upstream default frontend port 1420 sits inside that range, so
// `npm run tauri dev` dies in `beforeDevCommand` with `EACCES` before Tauri ever starts.
//
//   node script/dev.mjs            # desktop app (default)
//   node script/dev.mjs --port 8123
//
// The chosen port is written to `.tauri/dev-url.json`, which is passed to the Tauri CLI as a
// config overlay (`-c`). Overlaying the file — rather than editing src-tauri/tauri.conf.json —
// keeps the upstream config untouched and the port decision in one place.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const OVERLAY = join(root, ".tauri", "dev-url.json");
const DEFAULT_FIRST_PORT = 1420;
const MAX_PORT_TRIES = 200;

// Resolve a package's bin entry to a real file path, then run it with the current `node`
// binary. Spawning `npx.cmd` directly fails with EINVAL on Windows, and going through
// `shell: true` concatenates arguments unescaped — which breaks any path containing a space
// (this checkout lives under `D:\AI Coding\...`).
function resolveBin(packageName) {
  const pkgPath = require.resolve(`${packageName}/package.json`);
  const pkg = require(pkgPath);
  const binField = pkg.bin;
  const relative = typeof binField === "string" ? binField : binField[Object.keys(binField)[0]];
  return join(dirname(pkgPath), relative);
}

const NODE = process.execPath;
const VITE_ENTRY = resolveBin("vite");
const TAURI_ENTRY = resolveBin("@tauri-apps/cli");

function parseArgs(argv) {
  const args = { port: null, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      args.port = Number(argv[++i]);
    } else {
      args.extra.push(argv[i]);
    }
  }
  return args;
}

// A port is usable when we can bind it on 127.0.0.1. Windows reports reserved ports as
// EACCES rather than EADDRINUSE, so both must be treated as "try the next one".
function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

async function pickPort(first) {
  for (let port = first; port < first + MAX_PORT_TRIES; port++) {
    if (port > 65535) break;
    // Sequential on purpose: the goal is the *first* usable port, so probing the remaining
    // candidates in parallel would only waste sockets.
    // oxlint-disable-next-line no-await-in-loop
    if (await probePort(port)) return port;
  }
  throw new Error(`no free port found in ${first}..${first + MAX_PORT_TRIES}`);
}

// Poll the port until the dev server answers, so Tauri opens the window once the frontend is up.
async function waitForPort(port, timeoutMs = 60000, child) {
  const deadline = Date.now() + timeoutMs;
  /* oxlint-disable no-await-in-loop -- polling loop: each attempt must follow the previous one */
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`dev server exited early with code ${child.exitCode}`);
    }
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error(`dev server did not start listening on ${port} within ${timeoutMs}ms`);
}

function run(command, args, options = {}) {
  return spawn(command, args, {
    cwd: root,
    stdio: options.stdio ?? ["ignore", "inherit", "inherit"],
    env: options.env ?? process.env,
  });
}

function shutdown(children) {
  for (const child of children) {
    if (!child || child.exitCode !== null || child.killed) continue;
    if (process.platform === "win32") {
      // Kill the whole tree: the direct child is the CLI process and the dev server / app are
      // its descendants (Tauri re-runs `beforeDevCommand` and the Rust build).
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      });
    } else {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  }
}

const { port: requested, extra } = parseArgs(process.argv.slice(2));
const first = requested ?? Number(process.env.VITE_PORT ?? DEFAULT_FIRST_PORT);
const port = await pickPort(first);

mkdirSync(dirname(OVERLAY), { recursive: true });
// Two keys are overlaid:
//   devUrl            — where Tauri points the webview (the port we just picked)
//   beforeDevCommand  — cleared, because this script already owns the Vite instance.
//                       Letting Tauri run it too would start a second Vite on the upstream
//                       default port, which is exactly the port that may be reserved.
writeFileSync(
  OVERLAY,
  `${JSON.stringify(
    { build: { devUrl: `http://127.0.0.1:${port}`, beforeDevCommand: "" } },
    null,
    2,
  )}\n`,
);

console.log(
  `[dev] frontend port: ${port}${port !== first ? ` (${first} unavailable — reserved or in use)` : ""}`,
);

const children = [];
const cleanup = () => shutdown(children);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
process.on("exit", cleanup);

const vite = run(
  NODE,
  [VITE_ENTRY, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    env: { ...process.env, VITE_PORT: String(port) },
  },
);
children.push(vite);

try {
  await waitForPort(port, 60000, vite);
} catch (error) {
  console.error(`[dev] ${error.message}`);
  cleanup();
  process.exit(1);
}

console.log(`[dev] launching Tauri against http://127.0.0.1:${port}`);
const tauri = run(NODE, [TAURI_ENTRY, "dev", "-c", OVERLAY, ...extra], {
  // Tell the Tauri CLI the dev server is bound to loopback so it does not warn about a
  // wildcard-address conflict when the port is also claimed on 0.0.0.0 by something else.
  env: { ...process.env, TAURI_DEV_HOST: "127.0.0.1" },
});
children.push(tauri);

tauri.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
