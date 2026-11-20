import { expect, test } from "vitest";
import type * as vscode from "vscode";
import { rememberLog } from "../src/host/logMemory";

function fakeChannel() {
  const calls: string[] = [];
  const channel = {
    name: "Phew",
    info: (...values: unknown[]) => calls.push(`info ${values.join(" ")}`),
    warn: (...values: unknown[]) => calls.push(`warn ${values.join(" ")}`),
    error: (value: unknown) => calls.push(`error ${String(value)}`),
    show: () => calls.push("show"),
  };
  return { channel: channel as unknown as vscode.LogOutputChannel, calls };
}

test("forwards everything to the channel and keeps the latest lines", () => {
  const { channel, calls } = fakeChannel();
  const log = rememberLog(channel, 3);
  log.channel.info("one", 1);
  log.channel.warn("two");
  log.channel.error(new Error("three"));
  log.channel.info("four");
  log.channel.show();
  expect(calls).toEqual(["info one 1", "warn two", "error Error: three", "info four", "show"]);
  const recent = log.recent();
  expect(recent).toHaveLength(3);
  expect(recent.map((line) => line.replace(/^\d\d:\d\d:\d\d /, ""))).toEqual(["warn two", "error three", "info four"]);
  expect(log.channel.name).toBe("Phew");
});

test("cuts a very long line", () => {
  const { channel } = fakeChannel();
  const log = rememberLog(channel);
  log.channel.info("x".repeat(5000));
  expect(log.recent()[0]?.length).toBeLessThan(620);
});
