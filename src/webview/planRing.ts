import type { ModelPlanView } from "../shared/protocol";

/**
 * The plan of a model as a hollow ring: the arc is what is left. Next to it, a short text such as "190/200".
 * The context of the chat is a filled circle, so the two never look alike.
 */
export function planRingNode(plan: ModelPlanView, compact = false): HTMLElement {
  const node = document.createElement("span");
  node.className = `plan-ring${compact ? " compact" : ""}`;
  const dial = document.createElement("span");
  dial.className = "plan-ring-dial";
  // Without a limit (a balance), the ring is full and the text tells the amount.
  dial.style.setProperty("--left", `${Math.round((plan.left ?? 1) * 360)}deg`);
  const text = document.createElement("span");
  text.className = "plan-ring-text";
  text.textContent = compact && plan.plan ? `${plan.plan} · ${plan.short}` : plan.short;
  node.append(dial, text);
  node.title = plan.details.join("\n");
  return node;
}

/** The words for screen readers: "GitHub Copilot Free. Chat messages: 190 of 200 left (10 used). …" */
export function planLabel(plan: ModelPlanView): string {
  return plan.details.join(". ");
}
