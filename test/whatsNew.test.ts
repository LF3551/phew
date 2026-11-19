import { expect, test } from "vitest";
import { minorVersion, whatsNewFor } from "../src/core/whatsNew";

test("shows what is new after an update to a new minor version", () => {
  const news = whatsNewFor("0.5.0", "0.4.2");
  expect(news?.version).toBe("0.5");
  expect(news?.items.length).toBeGreaterThan(0);
});

test("shows nothing after a fresh install, a patch, or a version without notes", () => {
  expect(whatsNewFor("0.5.0", undefined)).toBeUndefined();
  expect(whatsNewFor("0.5.3", "0.5.1")).toBeUndefined();
  expect(whatsNewFor("9.9.0", "0.5.0")).toBeUndefined();
});

test("people who update from 0.5 see what is new in 1.0", () => {
  expect(whatsNewFor("1.0.0", "0.5.0")?.version).toBe("1.0");
});

test("the minor version drops the patch", () => {
  expect(minorVersion("0.5.3")).toBe("0.5");
  expect(minorVersion("1.12.0")).toBe("1.12");
});
