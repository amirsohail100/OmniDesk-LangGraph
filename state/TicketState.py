from typing import Annotated, TypedDict


def merge_score_dicts(existing: dict, new_update: dict) -> dict:
    """Reducer: the 3 parallel risk-check branches each return a partial dict;
    this merges them into one 'risk_scores' dict instead of overwriting it."""
    if existing is None:
        return new_update
    return {**existing, **new_update}


class TicketState(TypedDict):
    raw_ticket: str
    ticket_text: str                 # cleaned by intake_node
    category: str                     # billing / technical / general
    urgency: str                       # low / medium / high
    risk_scores: Annotated[dict[str, int], merge_score_dicts]
    risk_level: str                     # Low / Medium / High (set by triage_node)
    requires_human: bool                 # decided once at triage, read repeatedly
    draft: str
    review_feedback: str
    is_approved: bool
    attempt: int
