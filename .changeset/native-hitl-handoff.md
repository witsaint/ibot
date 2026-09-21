---
"@i-bot/types": minor
---

Add a native, thin human-in-the-loop handoff to the agent run loop (borrowing Mastra's
suspend/resume blueprint without adopting the framework or a second storage layer).

A new `request_handoff({reason, kind})` tool lets the agent explicitly pause when it's genuinely
blocked on something only the human can do — a login, an OTP/2FA, a secret that isn't in the
vault, a choice only they know, or a captcha it can't clear. Calling it ends the turn cleanly
(via a `hasToolCall` stop condition on the existing `streamText` loop) instead of the old
prose-only "please take over" that left the turn to trail off with no signal.

The suspend is now observable: `ConversationEvent` gains a `needs_human` variant carrying the
plain ask + a `HandoffKind` classifier, and `run.state` gains an `awaitingHuman` flag — so the UI
can show a distinct "waiting for you" state instead of the same busy spinner, and a notification
has something to fire on. Resume stays free: the user's next message starts a fresh turn that
replays the transcript (including the handoff request), so no execution-state snapshot is needed.

Subagent/background runs are unchanged — they still bubble a block back to the foreground voice as
prose; only the foreground and proactive-relay voices get the tool.
