"""Simple triage — single prompt, no tools yet."""
def run(text, model):
    return model.complete("Is this spam or a query? " + text)
