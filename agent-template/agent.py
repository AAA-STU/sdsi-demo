"""Minimal agent scaffold — extend this for your use case."""
def run(task: str) -> dict:
    # TODO: plan → use tools → produce a result with a human-in-the-loop gate
    return {"plan": [], "result": None, "escalated": False}
