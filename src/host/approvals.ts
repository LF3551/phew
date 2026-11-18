import type { ApprovalKind, HostMessage, HunkView } from "../shared/protocol";

export interface ApprovalRequest {
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly detail: string;
  readonly reason?: string;
  readonly hunks?: readonly HunkView[];
  /** Answers that the user can click, for questions. */
  readonly options?: readonly string[];
  readonly allowText?: boolean;
  /** For commands: the prefix that "Always allow" adds to the allowlist, for example `npm test`. */
  readonly alwaysAllow?: string;
  /** Called when the user asks to see the change in the diff editor. */
  readonly openDiff?: () => void;
}

export interface ApprovalDecision {
  readonly allowed: boolean;
  /** Selected hunk indexes for edit approvals. */
  readonly hunks?: readonly number[];
  /** The answer to a question. */
  readonly answer?: string;
}

interface Pending {
  readonly request: ApprovalRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
}

/** Sends approval requests to the chat view and waits for the decision of the user. */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;

  constructor(private readonly post: (message: HostMessage) => void) {}

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve({ allowed: false });
    const id = `approval_${Date.now().toString(36)}_${++this.counter}`;
    return new Promise((resolve) => {
      const onAbort = () => this.resolve(id, { allowed: false }, "cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        request,
        resolve: (decision) => {
          signal.removeEventListener("abort", onAbort);
          resolve(decision);
        },
      });
      this.post({
        type: "approval",
        id,
        kind: request.kind,
        title: request.title,
        detail: request.detail,
        ...(request.reason ? { reason: request.reason } : {}),
        ...(request.hunks ? { hunks: request.hunks } : {}),
        ...(request.options ? { options: request.options } : {}),
        ...(request.allowText !== undefined ? { allowText: request.allowText } : {}),
        ...(request.alwaysAllow ? { alwaysAllow: request.alwaysAllow } : {}),
      });
    });
  }

  answer(id: string, allowed: boolean, hunks?: readonly number[], text?: string): void {
    const label =
      text === "always"
        ? "always allowed"
        : text !== undefined
          ? allowed
            ? `answered: ${text.slice(0, 80)}`
            : "skipped"
          : allowed
            ? "allowed"
            : "denied";
    this.resolve(id, { allowed, hunks, answer: text }, label);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  openDiff(id: string): void {
    this.pending.get(id)?.request.openDiff?.();
  }

  /** Denies all open requests, for example when the chat view closes. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, { allowed: false }, "cancelled");
  }

  private resolve(id: string, decision: ApprovalDecision, label: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(decision);
    this.post({ type: "approvalResolved", id, decision: label });
  }
}
