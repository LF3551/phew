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
  readonly messageActions: "hover" | "always";
  readonly avatars: boolean;
}

export const defaultAppearance: Appearance = {
  style: "bubbles",
  accentColor: "",
  userBubbleColor: "",
  fontFamily: "",
  lineHeight: null,
  codeFontSize: null,
  timestamps: "hover",
  messageActions: "hover",
  avatars: true,
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
