/** Appearance of the chat. Users change it in the chat (Aa) and in the settings. */
export type ChatStyle = "bubbles" | "classic" | "compact";
export type Visibility = "hover" | "always" | "never";

export interface Appearance {
  readonly style: ChatStyle;
  /** CSS color, or empty for the theme color. */
  readonly accentColor: string;
  readonly userBubbleColor: string;
  readonly fontFamily: string;
  readonly lineHeight: number | null;
  readonly codeFontSize: number | null;
  readonly timestamps: Visibility;
  /** The clock of message times: the language of VS Code, or always 24 or 12 hours. */
  readonly clock: "auto" | "24h" | "12h";
  readonly messageActions: "hover" | "always";
  readonly avatars: boolean;
  /** How much the mascot moves: blinks and gaze, only blinks, or nothing. */
  readonly mascot: "lively" | "calm" | "still";
}

export const defaultAppearance: Appearance = {
  style: "bubbles",
  accentColor: "",
  userBubbleColor: "",
  fontFamily: "",
  lineHeight: null,
  codeFontSize: null,
  timestamps: "hover",
  clock: "auto",
  messageActions: "hover",
  avatars: true,
  mascot: "lively",
};

/** Accepts hex, rgb(a), hsl(a), and named colors. Everything else is rejected, so no other CSS reaches the view. */
export function safeColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const color = value.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return color;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.%]+\s*,?\s*[\d.%]+\s*,?\s*[\d.%]+\s*([,/]\s*[\d.%]+\s*)?\)$/i.test(color))
    return color;
  if (/^[a-z]{3,20}$/i.test(color)) return color.toLowerCase();
  return "";
}

/** Accepts font family lists without characters that could end the CSS value. */
export function safeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  const font = value.trim().slice(0, 200);
  return /^[\w\s,'"-]*$/.test(font) ? font : "";
}

/** Preset accent colors for the quick picker in the chat. */
export const accentPresets: readonly { readonly name: string; readonly color: string }[] = [
  { name: "Phew", color: "#22b8cf" },
  { name: "Blue", color: "#4c8dff" },
  { name: "Violet", color: "#8b5cf6" },
  { name: "Green", color: "#2fb67c" },
  { name: "Orange", color: "#f08c2e" },
  { name: "Pink", color: "#e64980" },
];

/** Dark or light text for a background color, from its luminance (WCAG). Non-hex colors get white text. */
export function textOnColor(color: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return "#fff";
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const value = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  // The text color with more contrast (WCAG): white, or the dark ink of Phew (luminance about 0.009).
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const onWhite = 1.05 / (luminance + 0.05);
  const onDark = (luminance + 0.05) / 0.059;
  return onDark > onWhite ? "#10181a" : "#fff";
}

function luminanceOf(hex: string): number | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  if (!match) return undefined;
  const full = match.length === 3 ? [...match].map((c) => c + c).join("") : match;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const value = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A button in the accent color with readable text. Some colors, such as a mid violet, give neither white nor
 * dark text a contrast of 4.5; then the button gets a little darker until white text reads well.
 */
export function accentButton(color: string): { background: string; text: string } {
  const text = textOnColor(color);
  const hex =
    /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1] ?? /^#([0-9a-f]{3})$/i.exec(color.trim())?.[1]?.replace(/./g, "$&$&");
  const luminance = luminanceOf(color);
  if (!hex || luminance === undefined) return { background: color, text };
  const contrast = text === "#fff" ? 1.05 / (luminance + 0.05) : (luminance + 0.05) / 0.059;
  if (contrast >= 4.5) return { background: color, text };
  const channels = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  for (let share = 0.9; share >= 0.4; share -= 0.05) {
    const darker = `#${channels
      .map((value) =>
        Math.round(value * share)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
    if (1.05 / ((luminanceOf(darker) ?? 0) + 0.05) >= 4.5) return { background: darker, text: "#fff" };
  }
  return { background: color, text };
}

type Rgb = readonly [number, number, number];

/** "#rrggbb", "#rgb", or "rgb(r, g, b)" as numbers; undefined for anything else. */
export function parseRgb(color: string): Rgb | undefined {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The accent as a text color on a background: the accent itself when it reads well (contrast 4.5), otherwise
 * mixed step by step with the text color of the theme until it does, so the hue stays.
 */
export function readableAccent(accent: string, background: string | readonly string[], foreground: string): string {
  const color = parseRgb(accent);
  const backs = (typeof background === "string" ? [background] : background)
    .map((value) => parseRgb(value))
    .filter((value): value is Rgb => value !== undefined);
  const fore = parseRgb(foreground);
  if (!color || backs.length === 0 || !fore) return accent;
  for (let share = 0; share <= 1.0001; share += 0.05) {
    const mixed = color.map((value, index) =>
      Math.round(value * (1 - share) + (fore[index] ?? 0) * share),
    ) as unknown as Rgb;
    if (backs.every((back) => contrastRatio(mixed, back) >= 4.5)) return `rgb(${mixed.join(", ")})`;
  }
  return foreground;
}
