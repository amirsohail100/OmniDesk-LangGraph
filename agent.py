import uuid

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command

from state.TicketState import TicketState
from tools.nodes import (
    intake_node,
    classifier_node,
    toxicity_node,
    fraud_node,
    pr_risk_node,
    triage_node,
    route_by_triage,
    escalate_node,
    drafter_node,
    route_after_draft,
    ai_reviewer_node,
    human_review_node,
    should_stop_looping,
    MAX_ATTEMPTS,
)

graph = StateGraph(TicketState)

graph.add_node("intake", intake_node)
graph.add_node("classifier", classifier_node)
graph.add_node("toxicity", toxicity_node)
graph.add_node("fraud", fraud_node)
graph.add_node("pr_risk", pr_risk_node)
graph.add_node("triage", triage_node)
graph.add_node("escalate", escalate_node)
graph.add_node("drafter", drafter_node)
graph.add_node("ai_reviewer", ai_reviewer_node)
graph.add_node("human_review", human_review_node)

# 1) SEQUENTIAL - must happen in order
graph.add_edge(START, "intake")
graph.add_edge("intake", "classifier")

# 2) PARALLEL - all 3 risk checks fan out from the classifier at once, and
#    "triage" only runs once ALL THREE have merged their scores (fan-in join).
graph.add_edge("classifier", "toxicity")
graph.add_edge("classifier", "fraud")
graph.add_edge("classifier", "pr_risk")
graph.add_edge("toxicity", "triage")
graph.add_edge("fraud", "triage")
graph.add_edge("pr_risk", "triage")

# 3) CONDITIONAL - routed twice: once to decide escalate-vs-draft, once to
#    decide which kind of reviewer should see the draft.
graph.add_conditional_edges("triage", route_by_triage, {"escalate": "escalate", "drafter": "drafter"})
graph.add_conditional_edges("drafter", route_after_draft, {"ai_reviewer": "ai_reviewer", "human_review": "human_review"})

graph.add_edge("escalate", END)

# 4) ITERATIVE - fully automated retry loop for low-risk tickets
graph.add_conditional_edges("ai_reviewer", should_stop_looping, {"drafter": "drafter", END: END})

# 5) HUMAN-IN-THE-LOOP - same retry loop, but a human decides instead of the AI
graph.add_conditional_edges("human_review", should_stop_looping, {"drafter": "drafter", END: END})

# interrupt() needs a checkpointer so a paused run can be resumed by thread_id.
# MemorySaver lives inside this one process - see README before running multiple workers.
compiled_graph = graph.compile(checkpointer=MemorySaver())


class SessionNotFound(Exception):
    """Raised when resuming a thread that doesn't exist or has already finished."""


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}


def _derive_status(result: dict) -> str:
    if result.get("risk_level") == "High":
        return "escalated"
    if result.get("is_approved"):
        return "auto_resolved" if not result.get("requires_human") else "approved"
    return "max_attempts"


def _package(thread_id: str, result: dict) -> dict:
    if "__interrupt__" in result:
        payload = result["__interrupt__"][0].value
        return {
            "thread_id": thread_id,
            "status": "awaiting_review",
            "draft": payload["draft"],
            "attempt": payload["attempt"],
            "max_attempts": MAX_ATTEMPTS,
            "category": payload["category"],
            "risk_level": payload["risk_level"],
            "risk_scores": result.get("risk_scores", {}),
        }

    return {
        "thread_id": thread_id,
        "status": _derive_status(result),
        "draft": result.get("draft", ""),
        "attempt": result.get("attempt", 0),
        "max_attempts": MAX_ATTEMPTS,
        "category": result.get("category", ""),
        "risk_level": result.get("risk_level", ""),
        "risk_scores": result.get("risk_scores", {}),
    }


def start_session(raw_ticket: str) -> dict:
    """Starts a new run. Stops either at the human review interrupt, or at a
    fully-automated outcome (escalated / auto-resolved)."""
    thread_id = uuid.uuid4().hex
    result = compiled_graph.invoke(
        {
            "raw_ticket": raw_ticket,
            "ticket_text": "",
            "category": "",
            "urgency": "",
            "risk_scores": {},
            "risk_level": "",
            "requires_human": False,
            "draft": "",
            "review_feedback": "",
            "is_approved": False,
            "attempt": 0,
        },
        config=_config(thread_id),
    )
    return _package(thread_id, result)


def resume_session(thread_id: str, response: str) -> dict:
    """Feeds the human's answer back into a paused run."""
    config = _config(thread_id)

    snapshot = compiled_graph.get_state(config)
    if not snapshot.next:  # nothing pending: unknown thread or already finished
        raise SessionNotFound(thread_id)

    result = compiled_graph.invoke(Command(resume=response), config=config)
    return _package(thread_id, result)
