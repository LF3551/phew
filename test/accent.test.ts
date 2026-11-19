import { expect, test } from "vitest";
import { accentButton, contrastRatio, parseRgb, readableAccent, textOnColor } from "../src/core/appearance";

const ratio = (a: string, b: string) => contrastRatio(parseRgb(a) ?? [0, 0, 0], parseRgb(b) ?? [0, 0, 0]);

test("text in an accent reads well on light and dark backgrounds, and keeps a color that already does", () => {
  for (const accent of ["#22b8cf", "#4c8dff", "#8b5cf6", "#2fb67c", "#f08c2e", "#e64980", "#ffd400"]) {
    expect(ratio(readableAccent(accent, "#f8f8f8", "#3b3b3b"), "#f8f8f8")).toBeGreaterThanOrEqual(4.5);
    const dark = readableAccent(accent, ["#181818", "#313131"], "#cccccc");
    expect(ratio(dark, "#181818")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(dark, "#313131")).toBeGreaterThanOrEqual(4.5);
  }
  expect(readableAccent("#f08c2e", "#181818", "#cccccc")).toBe("rgb(240, 140, 46)");
  expect(readableAccent("not a color", "#181818", "#cccccc")).toBe("not a color");
});

test("a button in the accent gets the text with more contrast, and a darker shade when neither reads", () => {
  expect(textOnColor("#ffd400")).toBe("#10181a");
  expect(textOnColor("#1f4e8c")).toBe("#fff");
  for (const accent of ["#22b8cf", "#4c8dff", "#8b5cf6", "#2fb67c", "#f08c2e", "#e64980"]) {
    const button = accentButton(accent);
    expect(ratio(button.text, button.background)).toBeGreaterThanOrEqual(4.5);
  }
  expect(accentButton("#2fb67c").background).toBe("#2fb67c");
  expect(accentButton("#8b5cf6").background).not.toBe("#8b5cf6");
});
