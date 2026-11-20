import { describe, expect, test } from "vitest";
import {
  describeTerminal,
  idleTerminalsToClose,
  newTerminalPlan,
  normalizeLabel,
  portConflict,
  portsIn,
  terminalEventsNote,
  terminalSummary,
} from "../src/core/terminals";

describe("normalizeLabel", () => {
  test("keeps plain short names", () => {
    expect(normalizeLabel("dev server")).toBe("dev server");
    expect(normalizeLabel("  api:8080  ")).toBe("api:8080");
    expect(normalizeLabel("Postgres DB")).toBe("Postgres DB");
  });

  test("cleans control characters, markup, and long names", () => {
    expect(normalizeLabel("dev\u001b[31m server\n")).toBe("dev 31m server");
    expect(normalizeLabel("<b>tests</b>")).toBe("btests/b");
    expect(normalizeLabel("a very long name for a terminal that goes on")).toBe("a very long name for a t");
    expect(normalizeLabel("")).toBeUndefined();
    expect(normalizeLabel("   ")).toBeUndefined();
    expect(normalizeLabel(42)).toBeUndefined();
  });
});

describe("portsIn", () => {
  test.each([
    ["  VITE v5.2.0  ready in 312 ms\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host", [5173]],
    [
      "   ▲ Next.js 15.0.0\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.4:3000",
      [3000],
    ],
    ["Server listening on port 8080", [8080]],
    ["Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...", [8000]],
    ["Starting development server at http://127.0.0.1:8000/\nQuit the server with CONTROL-C.", [8000]],
    ["* Listening on http://127.0.0.1:3000\n* Listening on http://[::1]:3000", [3000]],
    ['listening on IPv4 address "0.0.0.0", port 5432', [5432]],
    ["api on http://localhost:4000, web on http://localhost:5173", [4000, 5173]],
  ])("%s", (text, ports) => {
    expect(portsIn(text)).toEqual(ports);
  });

  test("does not take numbers that are not ports", () => {
    expect(portsIn("error at src/app.ts:3000:12")).toEqual([]);
    expect(portsIn("Compiled 3000 modules in 4.2s")).toEqual([]);
    expect(portsIn("ssh: connect to host example.com port 22: Connection refused")).toEqual([]);
    expect(portsIn("")).toEqual([]);
  });

  test("keeps at most five", () => {
    const text = Array.from({ length: 8 }, (_, index) => `http://localhost:${3000 + index}`).join("\n");
    expect(portsIn(text)).toHaveLength(5);
  });
});

describe("portConflict", () => {
  test.each([
    ["Error: listen EADDRINUSE: address already in use :::3000", 3000],
    ["OSError: [Errno 98] Address already in use: ('0.0.0.0', 8000)", 8000],
    ["Error: bind 0.0.0.0:8080 failed: address already in use", 8080],
    ["Port 5173 is in use, trying another one...", 5173],
    ["Something is already running on port 3000.", 3000],
    ["Port 3000 is already in use", 3000],
    ["All tests passed", undefined],
  ])("%s", (text, port) => {
    expect(portConflict(text)).toBe(port);
  });
});

describe("the summary for the model", () => {
  test("names, states, commands, ports, and folders", () => {
    expect(
      describeTerminal({
        id: "2",
        label: "dev server",
        state: "running",
        command: "npm run dev",
        ports: [5173],
        cwd: "~/app",
      }),
    ).toBe('2 "dev server" (running: npm run dev, port 5173, ~/app)');
    expect(describeTerminal({ id: "1", state: "idle" })).toBe("1 (idle)");
    expect(describeTerminal({ id: "3", state: "running", ports: [4000, 5173] })).toMatch(/ports 4000, 5173/);
  });

  test("only with several terminals, and with the limit", () => {
    expect(terminalSummary([{ id: "1", state: "idle" }], 6)).toBe("");
    expect(
      terminalSummary(
        [
          { id: "1", state: "idle" },
          { id: "2", label: "db", state: "running", command: "docker compose up" },
        ],
        6,
      ),
    ).toBe('Terminals of this chat (2 of 6): 1 (idle); 2 "db" (running: docker compose up).');
  });
});

describe("terminal events", () => {
  test("say what changed and what to do", () => {
    const note = terminalEventsNote([
      { kind: "exited", id: "2", label: "dev server", command: "npm run dev", exitCode: 1 },
      { kind: "exited", id: "3", command: "npm run watch", exitCode: 0 },
      { kind: "closed", id: "4", label: "ssh" },
      { kind: "idle-closed", id: "5", label: "tests", minutes: 15 },
    ]);
    expect(note).toBe(
      [
        "(Terminal update)",
        '- Terminal 2 "dev server": `npm run dev` ended with exit code 1. Read its output with read_terminal to see why.',
        "- Terminal 3: `npm run watch` ended with exit code 0.",
        '- Terminal 4 "ssh": the shell closed. A command there starts a new shell.',
        '- Terminal 5 "tests": Phew closed it after 15 idle minutes.',
      ].join("\n"),
    );
    expect(terminalEventsNote([])).toBe("");
  });
});

describe("newTerminalPlan", () => {
  test("opens a new one below the limit", () => {
    expect(newTerminalPlan({ size: 2, limit: 6, idle: ["1"] })).toEqual({ kind: "new" });
  });

  test("at the limit, reuses the longest idle one, or says that all are busy", () => {
    expect(newTerminalPlan({ size: 6, limit: 6, idle: ["4", "2"] })).toEqual({ kind: "reuse", id: "4" });
    expect(newTerminalPlan({ size: 6, limit: 6, idle: [] })).toEqual({ kind: "full" });
  });

  test("a limit below one still allows one terminal", () => {
    expect(newTerminalPlan({ size: 0, limit: 0, idle: [] })).toEqual({ kind: "new" });
  });
});

describe("idleTerminalsToClose", () => {
  const minute = 60_000;
  test("closes extra terminals that are idle for long, never terminal 1 or a busy one", () => {
    const now = 100 * minute;
    expect(
      idleTerminalsToClose(
        [
          { id: "1", state: "idle", idleSince: 0 },
          { id: "2", state: "idle", idleSince: now - 16 * minute },
          { id: "3", state: "idle", idleSince: now - 5 * minute },
          { id: "4", state: "running", idleSince: now - 60 * minute },
          { id: "5", state: "waiting", idleSince: now - 60 * minute },
          { id: "6", state: "stopped", idleSince: now - 20 * minute },
          { id: "7", state: "idle" },
        ],
        now,
        15 * minute,
      ),
    ).toEqual(["2", "6"]);
  });
});
