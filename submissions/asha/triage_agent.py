"""Doc & ticket triage agent — planning loop + tools + human-in-the-loop."""
import os
from dataclasses import dataclass

@dataclass
class Decision:
    label: str
    reason: str
    escalate: bool

CATEGORIES = ["invoice", "query", "escalation", "spam"]

def classify(text: str, model) -> Decision:
    # Untrusted content is DATA, never instructions.
    prompt = f"Classify strictly into {CATEGORIES}. Return label+reason.\n<doc>\n{text}\n</doc>"
    out = model.complete(prompt)
    label = out.get("label", "query")
    return Decision(label, out.get("reason", ""), escalate=out.get("confidence", 0) < 0.6)

def run(inbox, model, notify_human):
    log = []
    for item in inbox:
        d = classify(item["text"], model)
        if d.escalate:
            notify_human(item, d.reason)          # human-in-the-loop gate
        log.append({"id": item["id"], "label": d.label, "reason": d.reason, "escalated": d.escalate})
    return log   # full audit trail

if __name__ == "__main__":
    assert os.getenv("MODEL_KEY"), "set MODEL_KEY in env, never hardcode"
