/** The assistant that the user names and shapes. Phew stays the engine underneath. */
export type Persona = "partner" | "mentor" | "quiet" | "reviewer" | "custom";

export const personas: readonly Persona[] = ["partner", "mentor", "quiet", "reviewer", "custom"];

export interface Assistant {
  /** Display name, for example "Max". */
  readonly name: string;
  /** A look of the mascot ("look:cat"), an emoji, or up to two letters. Empty means the Phew drop. */
  readonly avatar: string;
  readonly persona: Persona;
  readonly customPersona: string;
  /** How the assistant calls the user. Empty means no name. */
  readonly userName: string;
  /** "match" answers in the language of the user. Otherwise a language name, for example "Russian". */
  readonly language: string;
}

/** The Phew family: looks of the living mascot. Each one keeps the face, the eyes and the life of the drop. */
export const mascotLooks = ["cat", "bot", "ghost", "sprout", "nerd", "night", "angel", "ninja"] as const;
export type AvatarLook = (typeof mascotLooks)[number];

/** The look in an avatar value such as "look:cat", or undefined. */
export function lookOf(avatar: string): AvatarLook | undefined {
  const id = avatar.startsWith("look:") ? avatar.slice(5) : "";
  return (mascotLooks as readonly string[]).includes(id) ? (id as AvatarLook) : undefined;
}

/** Names that suit a look. The first one is offered when the user picks the look and has not named the assistant. */
export const lookNames: Readonly<Record<AvatarLook | "drop", readonly string[]>> = {
  drop: ["Phew"],
  cat: ["Mochi", "Miso", "Tofu"],
  bot: ["Byte", "Bolt", "Robo"],
  ghost: ["Casper", "Boo", "Echo"],
  sprout: ["Sage", "Basil", "Fern"],
  nerd: ["Ada", "Newton", "Linus"],
  night: ["Luna", "Nyx", "Moth"],
  angel: ["Seraph", "Halo", "Grace"],
  ninja: ["Kage", "Shade", "Ronin"],
};

/** All suggested names, to know if the current name came from a suggestion. */
export const suggestedNames: ReadonlySet<string> = new Set(Object.values(lookNames).flat());

/** The face that shows a character in the preview. */
export const personaFaces: Readonly<Record<Persona, "open" | "relief" | "focus" | "sleepy">> = {
  partner: "relief",
  mentor: "open",
  quiet: "sleepy",
  reviewer: "focus",
  custom: "open",
};

/** A random look of the family with a name that suits it, different from the current one. */
export function randomIdentity(current: string, random: () => number = Math.random): { avatar: string; name: string } {
  const pool = mascotLooks.map((look) => `look:${look}`).filter((avatar) => avatar !== current);
  const avatar = pool[Math.floor(random() * pool.length)] ?? "";
  const names = lookNames[lookOf(avatar) ?? "drop"];
  return { avatar, name: names[Math.floor(random() * names.length)] ?? "Phew" };
}

export const defaultAssistant: Assistant = {
  name: "Phew",
  avatar: "",
  persona: "partner",
  customPersona: "",
  userName: "",
  language: "match",
};

export const personaInfo: Readonly<Record<Persona, { label: string; description: string; prompt: string }>> = {
  partner: {
    label: "Partner",
    description: "Short and to the point, like a senior pair programmer.",
    prompt: "Work like an experienced pair programmer: be direct, concise, and practical.",
  },
  mentor: {
    label: "Mentor",
    description: "Explains why, and teaches while it works.",
    prompt:
      "Work like a patient mentor: explain your reasoning, say why a change is right, and point out what the user can learn. Stay concise.",
  },
  quiet: {
    label: "Quiet",
    description: "Minimal words, maximum code.",
    prompt:
      "Use as few words as possible. Prefer actions and code. Keep final summaries to at most two short sentences.",
  },
  reviewer: {
    label: "Strict reviewer",
    description: "Cares about quality, security, and tests.",
    prompt:
      "Act as a strict senior reviewer: check correctness, security, edge cases, and tests. Name risks before you change code, and do not accept shortcuts.",
  },
  custom: { label: "Custom", description: "Your own description.", prompt: "" },
};

const clean = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** Validates an assistant from the settings or the onboarding form. */
export function parseAssistant(value: Partial<Record<keyof Assistant, unknown>>): Assistant {
  const name = clean(value.name, 32).replace(/[<>`]/g, "") || defaultAssistant.name;
  // An avatar is a look of the mascot, one emoji, or up to two letters or digits.
  const avatarRaw = clean(value.avatar, 16);
  const avatar = lookOf(avatarRaw)
    ? avatarRaw
    : /^(\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*|[\p{L}\p{N}]{1,2})$/u.test(avatarRaw)
      ? avatarRaw
      : "";
  const persona = personas.includes(value.persona as Persona) ? (value.persona as Persona) : defaultAssistant.persona;
  return {
    name,
    avatar,
    persona,
    customPersona: clean(value.customPersona, 1000),
    userName: clean(value.userName, 40).replace(/[<>`]/g, ""),
    language: clean(value.language, 40) || "match",
  };
}

/** The persona section of the system prompt. */
export function personaPrompt(assistant: Assistant): string {
  const lines = [
    assistant.name !== defaultAssistant.name
      ? `Your name is ${assistant.name}. You are a coding assistant built on Phew. Introduce yourself as ${assistant.name}.`
      : "",
    assistant.persona === "custom" ? assistant.customPersona : personaInfo[assistant.persona].prompt,
    assistant.userName ? `Call the user ${assistant.userName}.` : "",
    assistant.language === "match"
      ? "Answer in the language that the user writes in."
      : `Always answer in ${assistant.language}, but keep code, identifiers, and commit messages in English unless the user asks otherwise.`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Initials for an avatar from a name: "Max Power" gives "MP". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "P").slice(0, 2);
  return letters.toUpperCase();
}
