const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const rootDir = __dirname;
const childProcesses = [];
let shuttingDown = false;

function prefixStream(stream, target, name) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      target.write(`[${name}] ${line}\n`);
    }
  });

  stream.on("end", () => {
    if (buffer) {
      target.write(`[${name}] ${buffer}\n`);
      buffer = "";
    }
  });
}

function stopChildren(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const proc of childProcesses) {
    if (!proc.killed) {
      proc.kill(signal);
    }
  }
}

function spawnProcess(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  childProcesses.push(child);

  prefixStream(child.stdout, process.stdout, name);
  prefixStream(child.stderr, process.stderr, name);

  child.on("exit", (code, signal) => {
    process.stdout.write(`[${name}] exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}\n`);

    if (!shuttingDown) {
      stopChildren();
      process.exit(code ?? 0);
    }
  });

  child.on("error", (error) => {
    process.stderr.write(`[${name}] failed to start: ${error.message}\n`);

    if (!shuttingDown) {
      stopChildren();
      process.exit(1);
    }
  });
}

function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.unref();

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(findAvailablePort(startPort + 1));
        return;
      }

      reject(error);
    });

    server.listen(startPort, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  const apiPort = await findAvailablePort(Number(process.env.PORT || 3001));
  const apiBase = `http://localhost:${apiPort}`;

  process.stdout.write(`[DEV] API base: ${apiBase}\n`);

  spawnProcess("API", process.execPath, [path.join(rootDir, "server.cjs")], {
    PORT: String(apiPort),
  });

  spawnProcess(
    "VITE",
    process.execPath,
    [path.join(rootDir, "node_modules", "vite", "bin", "vite.js")],
    {
      VITE_API_BASE: apiBase,
    }
  );
}

process.on("SIGINT", () => stopChildren("SIGINT"));
process.on("SIGTERM", () => stopChildren("SIGTERM"));

main().catch((error) => {
  process.stderr.write(`[DEV] failed to start: ${error.message}\n`);
  stopChildren();
  process.exit(1);
});
