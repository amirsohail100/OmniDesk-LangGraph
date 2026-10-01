from typing import Dict, Literal

from pydantic import BaseModel, Field


class StartRequest(BaseModel):
    raw_ticket: str = Field(min_length=1, max_length=4000)


class ResumeRequest(BaseModel):
    thread_id: str = Field(min_length=1, max_length=64)
    response: str = Field(min_length=1, max_length=2000)


class SessionResponse(BaseModel):
    thread_id: str
    status: Literal["awaiting_review", "approved", "auto_resolved", "escalated", "max_attempts"]
    draft: str
    attempt: int
    max_attempts: int
    category: str
    risk_level: str
    risk_scores: Dict[str, int]
