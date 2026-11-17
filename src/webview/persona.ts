import type { Achievement, Wrapped } from "../core/achievements";
import { initials, type Persona, personaInfo, personas } from "../core/persona";
import type { ViewState, WebviewMessage } from "../shared/protocol";

/** The assistant: the living mascot, the introduction card, Phew Wrapped, achievements, and sounds. */

type AssistantView = ViewState["assistant"];
type Post = (message: WebviewMessage) => void;
export type MascotState = "idle" | "working" | "done" | "failed";

const svgNs = "http://www.w3.org/2000/svg";
const reliefEyes = "M48 140q32 36 64 0M144 140q32 36 64 0";
const focusEyes = "M54 150h52M150 150h52";
const worryEyes = "M52 162q28-30 56-8M148 154q28-22 56 8";
const dropPath = "M198 30c-14 20-24 33-24 47a24 24 0 0 0 48 0c0-14-10-27-24-47z";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(svgNs, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** The Phew drop: relieved eyes and a drop of sweat. CSS animates it by `data-state`. */
export function mascot(state: MascotState = "idle"): SVGSVGElement {
  const root = svg("svg", { viewBox: "0 0 256 256", class: "mascot", "data-state": state, "aria-hidden": "true" });
  root.append(svg("rect", { class: "m-face", width: "256", height: "256", rx: "76" }));
  for (const [kind, d] of [
    ["relief", reliefEyes],
    ["focus", focusEyes],
    ["worry", worryEyes],
  ] as const) {
    root.append(svg("path", { class: `m-eyes m-${kind}`, d }));
  }
  root.append(svg("path", { class: "m-drop", d: dropPath }));
  return root;
}

/** The avatar of the assistant: the mascot, or the emoji or letters that the user chose. */
export function avatar(assistant: AssistantView | undefined, className: string, state: MascotState = "idle"): Element {
  if (!assistant?.avatar) {
    const node = mascot(state);
    node.classList.add(className);
    return node;
  }
  const chip = document.createElement("span");
  chip.className = `${className} avatar-chip${/^[\p{L}\p{N}]+$/u.test(assistant.avatar) ? "" : " emoji"}`;
  chip.dataset.state = state;
  chip.textContent = assistant.avatar;
  return chip;
}

/** Sets the state of the live mascots in the header and the welcome screen. */
export function setMascotState(state: MascotState): void {
  for (const node of document.querySelectorAll<HTMLElement | SVGElement>(".live-mascot")) {
    if (node.dataset.state === state) continue;
    node.dataset.state = state;
    // Restart one-shot animations.
    if (state === "done" || state === "failed") {
      node.classList.remove("again");
      void (node as HTMLElement).getBoundingClientRect();
      node.classList.add("again");
    }
  }
}

// Sounds

/** A soft sigh of relief: filtered breath noise that falls in pitch. */
function sigh(audio: AudioContext): number {
  const length = 0.75;
  const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate * length), audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
  const noise = audio.createBufferSource();
  noise.buffer = buffer;
  const filter = audio.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.4;
  filter.frequency.setValueAtTime(1500, audio.currentTime);
  filter.frequency.exponentialRampToValueAtTime(450, audio.currentTime + length);
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.35, audio.currentTime + 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + length);
  noise.connect(filter).connect(gain).connect(audio.destination);
  noise.start();
  // A quiet voiced tone under the breath.
  const voice = audio.createOscillator();
  const voiceGain = audio.createGain();
  voice.type = "sine";
  voice.frequency.setValueAtTime(240, audio.currentTime);
  voice.frequency.exponentialRampToValueAtTime(150, audio.currentTime + length);
  voiceGain.gain.setValueAtTime(0.0001, audio.currentTime);
  voiceGain.gain.exponentialRampToValueAtTime(0.03, audio.currentTime + 0.1);
  voiceGain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + length);
  voice.connect(voiceGain).connect(audio.destination);
  voice.start();
  voice.stop(audio.currentTime + length);
  return length;
}

function tones(audio: AudioContext, notes: readonly (readonly [number, number])[]): number {
  let at = audio.currentTime;
  for (const [from, to] of notes) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(from, at);
    oscillator.frequency.exponentialRampToValueAtTime(to, at + 0.18);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.07, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.23);
    at += 0.16;
  }
  return at - audio.currentTime + 0.1;
}

export function playSound(style: "phew" | "chime", event: "done" | "failed" | "input"): void {
  try {
    const AudioContextClass =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const audio = new AudioContextClass();
    let length: number;
    if (event === "input")
      length = tones(audio, [
        [660, 660],
        [880, 880],
      ]);
    else if (event === "failed")
      length = tones(audio, [
        [440, 400],
        [330, 300],
      ]);
    else
      length =
        style === "phew"
          ? sigh(audio)
          : tones(audio, [
              [880, 700],
              [660, 520],
            ]);
    setTimeout(() => void audio.close(), (length + 0.2) * 1000);
  } catch {
    // Sound is optional.
  }
}

// Dialogs

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function openDialog(className: string, label: string): { dialog: HTMLElement; close: () => void } {
  const overlay = document.getElementById("overlay") as HTMLElement;
  const dialog = el("div", `dialog ${className}`);
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", label);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  const close = () => {
    overlay.hidden = true;
    overlay.replaceChildren();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.onclick = (event) => {
    if (event.target === overlay) close();
  };
  return { dialog, close };
}

const avatarChoices = ["", "🤖", "🦊", "🐱", "🦉", "⚡", "🧠", "🚀"];
const languages: readonly (readonly [string, string])[] = [
  ["match", "My language"],
  ["English", "English"],
  ["Russian", "Русский"],
  ["German", "Deutsch"],
  ["Spanish", "Español"],
  ["French", "Français"],
  ["Ukrainian", "Українська"],
  ["Chinese", "中文"],
];

/** The card where the user names the assistant and picks a look and a character. */
export function showAssistantCard(current: AssistantView | undefined, first: boolean, post: Post): void {
  const { dialog, close } = openDialog("assistant-card", "Your assistant");
  const draft = {
    name: current?.name ?? "Phew",
    avatar: current?.avatar ?? "",
    persona: (current?.persona ?? "partner") as Persona,
    customPersona: "",
    userName: current?.userName ?? "",
    language: current?.language ?? "match",
  };

  const preview = el("div", "assistant-preview");
  const renderPreview = () => {
    const name = draft.name.trim() || "Phew";
    const bubble = el("div", "preview-text");
    bubble.append(el("strong", undefined, name));
    const greeting = draft.userName.trim() ? `Hi, ${draft.userName.trim()}! ` : "Hi! ";
    const lines: Record<Persona, string> = {
      partner: "What shall we fix?",
      mentor: "Let's fix it, and I'll show you why it works.",
      quiet: "Ready.",
      reviewer: "Show me the code. I'll check it properly.",
      custom: "Ready when you are.",
    };
    bubble.append(el("span", undefined, greeting + lines[draft.persona]));
    preview.replaceChildren(
      avatar({ ...draft, name, persona: draft.persona } as AssistantView, "preview-avatar", "done"),
      bubble,
    );
  };

  dialog.append(
    el("h2", undefined, first ? "Meet your assistant" : "Your assistant"),
    el("p", "dialog-lead", "Give it a name and a character. You can change this at any time."),
    preview,
  );

  const field = (label: string, control: HTMLElement) => {
    const wrap = el("label", "field");
    wrap.append(el("span", "field-label", label), control);
    return wrap;
  };

  const nameInput = el("input");
  nameInput.maxLength = 32;
  nameInput.placeholder = "Phew";
  nameInput.value = draft.name === "Phew" ? "" : draft.name;
  nameInput.addEventListener("input", () => {
    draft.name = nameInput.value;
    renderPreview();
    renderAvatars();
  });
  dialog.append(field("Name", nameInput));

  const avatars = el("div", "avatar-choices");
  const renderAvatars = () => {
    const letters = initials(draft.name.trim() || "Phew");
    const choices = [...new Set([...avatarChoices, letters])];
    avatars.replaceChildren(
      ...choices.map((choice) => {
        const button = el("button", choice === draft.avatar ? "selected" : undefined);
        button.type = "button";
        button.title = choice === "" ? "Phew drop" : choice;
        button.append(avatar({ ...draft, avatar: choice } as AssistantView, "choice-avatar"));
        button.addEventListener("click", () => {
          draft.avatar = choice;
          renderAvatars();
          renderPreview();
        });
        return button;
      }),
    );
  };
  const avatarField = el("div", "field");
  avatarField.append(el("span", "field-label", "Look"), avatars);
  dialog.append(avatarField);

  const personaRow = el("div", "persona-choices");
  const custom = el("textarea");
  custom.rows = 2;
  custom.maxLength = 1000;
  custom.placeholder = "For example: a calm senior engineer who loves tests and short answers.";
  custom.addEventListener("input", () => {
    draft.customPersona = custom.value;
  });
  const renderPersonas = () => {
    personaRow.replaceChildren(
      ...personas.map((persona) => {
        const button = el("button", persona === draft.persona ? "selected" : undefined);
        button.type = "button";
        button.append(
          el("strong", undefined, personaInfo[persona].label),
          el("span", undefined, personaInfo[persona].description),
        );
        button.addEventListener("click", () => {
          draft.persona = persona;
          renderPersonas();
          renderPreview();
        });
        return button;
      }),
    );
    custom.hidden = draft.persona !== "custom";
  };
  const personaField = el("div", "field");
  personaField.append(el("span", "field-label", "Character"), personaRow, custom);
  dialog.append(personaField);

  const row = el("div", "field-row");
  const userInput = el("input");
  userInput.maxLength = 40;
  userInput.placeholder = "Your name";
  userInput.value = draft.userName;
  userInput.addEventListener("input", () => {
    draft.userName = userInput.value;
    renderPreview();
  });
  const languageSelect = el("select");
  const options = languages.some(([value]) => value === draft.language)
    ? languages
    : [...languages, [draft.language, draft.language] as const];
  for (const [value, label] of options) {
    const option = el("option", undefined, label);
    option.value = value;
    languageSelect.append(option);
  }
  languageSelect.value = draft.language;
  languageSelect.addEventListener("change", () => {
    draft.language = languageSelect.value;
  });
  row.append(field("Call me", userInput), field("Answers in", languageSelect));
  dialog.append(row);

  const actions = el("div", "dialog-actions");
  const later = el("button", "secondary", first ? "Not now" : "Cancel");
  later.type = "button";
  later.addEventListener("click", () => {
    if (first) post({ type: "skipOnboarding" });
    close();
  });
  const save = el("button", "primary", "Save");
  save.type = "button";
  save.addEventListener("click", () => {
    post({ type: "saveAssistant", ...draft, name: draft.name.trim() || "Phew" });
    close();
  });
  actions.append(later, save);
  dialog.append(actions);

  renderAvatars();
  renderPersonas();
  renderPreview();
  nameInput.focus();
}

// Phew Wrapped

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours >= 10 || Number.isInteger(hours) ? Math.round(hours) : hours.toFixed(1)} h`;
}

function formatDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Draws the shareable card at 1200 × 630, the size of social previews. */
function drawWrapped(canvas: HTMLCanvasElement, data: Wrapped, name: string, accent: string): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = 1200;
  const height = 630;
  canvas.width = width;
  canvas.height = height;
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#0d1418");
  background.addColorStop(1, "#13262d");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  const glow = context.createRadialGradient(1040, 90, 10, 1040, 90, 520);
  glow.addColorStop(0, `${accent}55`);
  glow.addColorStop(1, `${accent}00`);
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  // The mascot.
  context.save();
  context.translate(72, 64);
  context.scale(0.42, 0.42);
  context.fillStyle = "#F0EDE8";
  context.beginPath();
  context.roundRect(0, 0, 256, 256, 76);
  context.fill();
  context.strokeStyle = "#30343B";
  context.lineWidth = 26;
  context.lineCap = "round";
  context.stroke(new Path2D(reliefEyes));
  context.fillStyle = "#22B8CF";
  context.fill(new Path2D(dropPath));
  context.restore();

  const font = (size: number, weight = 400) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.fillStyle = "#ffffff";
  context.font = font(40, 700);
  context.fillText(`${name} Wrapped`, 200, 104);
  context.fillStyle = "#9fb3ba";
  context.font = font(24);
  context.fillText(
    `${data.period === "week" ? "This week" : "This month"} · ${formatDay(data.from)} – ${formatDay(data.to)}`,
    200,
    146,
  );

  const tiles: readonly (readonly [string, string])[] = [
    [String(data.bugs), data.bugs === 1 ? "bug fixed" : "bugs fixed"],
    [`~${formatMinutes(data.minutesSaved)}`, "saved"],
    [String(data.tasks), data.tasks === 1 ? "task done" : "tasks done"],
    [`${data.streak}`, "day streak"],
  ];
  tiles.forEach(([value, label], index) => {
    const x = 72 + (index % 2) * 540;
    const y = 220 + Math.floor(index / 2) * 170;
    context.fillStyle = "#ffffff12";
    context.beginPath();
    context.roundRect(x, y, 510, 145, 22);
    context.fill();
    context.fillStyle = index === 0 ? accent : "#ffffff";
    context.font = font(68, 800);
    context.fillText(value, x + 32, y + 84);
    context.fillStyle = "#9fb3ba";
    context.font = font(26);
    context.fillText(label, x + 34, y + 122);
  });

  context.fillStyle = "#cfdde1";
  context.font = font(24);
  const facts = [
    data.topModel ? `Top model: ${data.topModel}` : "",
    `Active ${data.activeDays} of ${data.period === "week" ? 7 : 30} days`,
  ].filter(Boolean);
  context.fillText(facts.join("  ·  "), 72, 590);
  context.fillStyle = "#6f878f";
  context.font = font(22, 600);
  context.textAlign = "right";
  context.fillText("Bug fixed. Phew.  github.com/LF3551/phew", width - 72, 590);
  context.textAlign = "left";
}

export function summaryText(data: Wrapped, name: string): string {
  const period = data.period === "week" ? "week" : "month";
  return `My ${period} with ${name}: ${data.bugs} bugs fixed, ~${formatMinutes(data.minutesSaved)} saved, ${data.tasks} tasks done, ${data.streak}-day streak. Bug fixed. Phew. https://github.com/LF3551/phew`;
}

export function showWrapped(
  data: Wrapped,
  achievements: readonly (Achievement & { readonly earned: boolean })[],
  name: string,
  accent: string,
  post: Post,
): void {
  const { dialog, close } = openDialog("wrapped", `${name} Wrapped`);
  const header = el("div", "wrapped-header");
  const tabs = el("div", "segmented");
  for (const period of ["week", "month"] as const) {
    const button = el("button", data.period === period ? "active" : undefined, period === "week" ? "Week" : "Month");
    button.type = "button";
    button.addEventListener("click", () => post({ type: "showWrapped", period }));
    tabs.append(button);
  }
  const closeButton = el("button", "icon-button", "✕");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.addEventListener("click", close);
  header.append(el("h2", undefined, `${name} Wrapped`), tabs, closeButton);

  const canvas = el("canvas", "wrapped-canvas");
  drawWrapped(canvas, data, name, /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#22b8cf");

  const actions = el("div", "dialog-actions");
  const copy = el("button", "secondary", "Copy text");
  copy.type = "button";
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(summaryText(data, name));
    copy.textContent = "Copied";
  });
  const save = el("button", "primary", "Save image");
  save.type = "button";
  save.addEventListener("click", () =>
    post({ type: "saveImage", dataUrl: canvas.toDataURL("image/png"), fileName: `phew-wrapped-${data.to}.png` }),
  );
  actions.append(copy, save);

  const earned = achievements.filter((item) => item.earned).length;
  const list = el("ul", "badges");
  for (const item of achievements) {
    const badge = el("li", item.earned ? "earned" : "locked");
    badge.title = item.earned ? item.description : `Locked: ${item.description}`;
    const text = el("div");
    text.append(el("strong", undefined, item.title), el("span", undefined, item.description));
    badge.append(el("span", "badge-glyph", item.icon), text);
    list.append(badge);
  }
  dialog.append(
    header,
    canvas,
    actions,
    el("h3", undefined, `Achievements · ${earned} of ${achievements.length}`),
    list,
  );
}

export function showAchievementToast(achievement: Achievement, onOpen: () => void): void {
  const toast = el("button", "toast");
  toast.type = "button";
  const text = el("span", "toast-text");
  text.append(el("small", undefined, "Achievement unlocked"), el("strong", undefined, achievement.title));
  toast.append(el("span", "badge-glyph", achievement.icon), text);
  toast.addEventListener("click", () => {
    toast.remove();
    onOpen();
  });
  document.body.append(toast);
  setTimeout(() => toast.classList.add("leaving"), 6000);
  setTimeout(() => toast.remove(), 6600);
}
