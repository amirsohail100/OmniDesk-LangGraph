# OmniDesk-LangGraph

**The problem:** support teams get flooded with tickets. Manually triaging every one is slow; letting AI auto-reply to everything is dangerous — abusive, fraudulent, or legally sensitive tickets can't be left to a bot. Most teams end up doing neither well: safe, boring tickets sit in a queue for hours, while actually risky ones occasionally slip through an overworked agent.

**What OmniDesk does:** one pipeline, one entry point. Every ticket gets cleaned, classified, and risk-scored automatically. Low-risk, simple tickets are drafted and reviewed entirely by AI and resolved with no human involved. Anything with real risk — or just outside the simplest category — still gets drafted by AI, but a human has to approve it before it's considered done. Anything clearly dangerous (abuse, fraud, legal/PR threats) skips drafting entirely and goes straight to a human.

This single project deliberately uses all 5 workflow patterns from this series, each because the problem genuinely needs it — not bolted on for completeness.

## The graph

```
START → intake → classifier → ┬→ toxicity ─┐
                               ├→ fraud ────┼→ triage ─┬─(High risk)──→ escalate → END
                               └→ pr_risk ──┘          │
                                                        └─(else)───────→ drafter ─┬─(low risk, general)──→ ai_reviewer ─┐
                                                                                  │                                     ├─(approved / out of attempts)→ END
                                                                                  └─(everything else)────→ human_review ┘
                                                                                                                │
                                                                                            (rejected, attempts left) → back to drafter
```

| #   | Pattern               | Where                                                                                                                                                |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Sequential**        | `intake → classifier` must happen in that order before anything else can                                                                             |
| 2   | **Parallel**          | `classifier → {toxicity, fraud, pr_risk}` — 3 independent risk checks fan out at once, merged into one `risk_scores` dict by `triage` (fan-in join)  |
| 3   | **Conditional**       | `route_by_triage` (escalate vs. draft) and `route_after_draft` (AI review vs. human review) — the same draft is judged differently depending on risk |
| 4   | **Iterative**         | `drafter ↔ ai_reviewer` — a fully automated write/critique loop for low-risk tickets, up to 3 attempts                                               |
| 5   | **Human-in-the-loop** | `drafter ↔ human_review` — same loop, but a person approves or sends feedback via `interrupt()`, same mechanism as the ReplyDesk project             |

## Structure

```
OmniDesk-LangGraph/
├── main.py             # FastAPI app: /api/start, /api/resume, /api/health, serves the UI
├── agent.py             # All graph wiring + start_session / resume_session helpers
├── schema/
│   └── payload.py        # StartRequest / ResumeRequest / SessionResponse
├── state/
│   └── TicketState.py     # TicketState TypedDict + the risk_scores merge reducer
├── tools/
│   └── nodes.py             # All 10 nodes + all 3 router functions
├── static/
│   ├── index.html
│   ├── style.css
│   └── script.js             # ticket form → pipeline trace → outcome / review stepper
├── requirements.txt
└── .env                       # GROQ_API_KEY
```

## Endpoints

- `GET  /api/health` → `{"status": "ok"}`
- `POST /api/start` with `{"raw_ticket": "..."}`. Runs the whole pipeline up to either an automated outcome or the human-review interrupt. Rate limit: 3/minute per IP (this is the expensive call — at least 5 LLM calls: classifier + 3 parallel checks + drafter).
- `POST /api/resume` with `{"thread_id": "...", "response": "approved" | "<feedback>"}`. Rate limit: 15/minute per IP.
- Both return:
  ```json
  {
    "thread_id": "…",
    "status": "awaiting_review",
    "draft": "…",
    "attempt": 1,
    "max_attempts": 3,
    "category": "billing",
    "risk_level": "Medium",
    "risk_scores": { "toxicity_level": 10, "fraud_risk": 40, "pr_risk": 5 }
  }
  ```
  `status` is one of `awaiting_review`, `approved`, `auto_resolved`, `escalated`, `max_attempts`.
- `POST /api/resume` on an unknown or finished thread returns `404`.
- `GET /` serves the UI.

## Run locally

```bash
pip install -r requirements.txt
# put GROQ_API_KEY in .env
uvicorn main:app --reload --port 8000
```

Open `http://localhost:8000`. Try a plain "where is my order #1234" ticket to see the fully automated path, and something that mentions a lawyer or sounds hostile to see escalation.

## Before going to production

- **`MemorySaver` keeps paused sessions in this process's RAM** — same caveat as ReplyDesk. Running multiple workers breaks `/api/resume` (wrong worker won't have the thread), a restart loses every paused session, and finished sessions are never cleaned up. Swap in `langgraph-checkpoint-sqlite` or `langgraph-checkpoint-postgres` for real deployments.
- The 3 parallel risk checks and the classifier are 4 separate LLM calls that could run as 1-2 calls with structured output, which would be faster and cheaper — they're kept separate here so the parallel pattern is easy to see and reason about independently.
- `triage`'s thresholds (70 for High, 35 for Medium) and the "general + Low risk only" auto-resolve rule are a starting point — tune them against real tickets before trusting this with real customers.
- CORS is `allow_origins=["*"]`; restrict it to your real frontend domain. Tune rate limits to your traffic.
