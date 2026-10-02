const START_URL = "/api/start";
const RESUME_URL = "/api/resume";

const $ = (id) => document.getElementById(id);

const composeCard = $("composeCard");
const ticketInput = $("ticket");
const startBtn = $("startBtn");
const errorMsg = $("errorMsg");

const traceCard = $("traceCard");
const badgesEl = $("badges");
const barsEl = $("bars");

const outcomeCard = $("outcomeCard");
const outcomeText = $("outcomeText");

const draftCard = $("draftCard");
const draftTitle = $("draftTitle");
const draftEl = $("draft");
const attemptLabel = $("attemptLabel");
const stepsEl = $("steps");
const actions = $("actions");
const lastNote = $("lastNote");
const feedback = $("feedback");
const approveBtn = $("approveBtn");
const reviseBtn = $("reviseBtn");
const resetRow = $("resetRow");
const copyBtn = $("copyBtn");
const resetBtn = $("resetBtn");

let threadId = null;
let isLastRound = false;

const RISK_LABELS = { toxicity_level: "Toxicity", fraud_risk: "Fraud", pr_risk: "PR/Legal" };

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }

  if (!res.ok) {
    const message = typeof data.detail === "string" ? data.detail : data.error;
    throw new Error(message || `Request failed (${res.status})`);
  }
  return data;
}

function setBusy(busy, label) {
  [startBtn, approveBtn, reviseBtn].forEach((b) => (b.disabled = busy));
  if (label) startBtn.textContent = busy ? label : "Run pipeline";
}

function barColor(score) {
  if (score >= 70) return "var(--danger)";
  if (score >= 35) return "var(--warn)";
  return "var(--ok)";
}

function renderTrace(data) {
  traceCard.hidden = false;
  badgesEl.innerHTML = "";
  barsEl.innerHTML = "";

  const riskClass = `risk-${data.risk_level.toLowerCase()}`;
  [
    ["Category", data.category],
    ["Risk", data.risk_level, riskClass],
  ].forEach(([label, value, extraClass]) => {
    const span = document.createElement("span");
    span.className = `badge ${extraClass || ""}`.trim();
    span.textContent = `${label.toUpperCase()}: ${value}`;
    badgesEl.appendChild(span);
  });

  Object.entries(data.risk_scores || {}).forEach(([key, score]) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span class="bar-label">${RISK_LABELS[key] || key}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${score}%;background:${barColor(score)}"></span></span>
      <span class="bar-value">${score}</span>
    `;
    barsEl.appendChild(row);
  });
}

function renderSteps(attempt, max) {
  stepsEl.innerHTML = "";
  for (let i = 1; i <= max; i++) {
    const dot = document.createElement("i");
    if (i < attempt) dot.className = "done";
    if (i === attempt) dot.className = "current";
    stepsEl.appendChild(dot);
  }
}

function render(data) {
  threadId = data.thread_id;
  composeCard.hidden = true;
  renderTrace(data);

  if (data.status === "escalated") {
    draftCard.hidden = true;
    outcomeCard.hidden = false;
    outcomeCard.className = "card banner danger";
    outcomeText.textContent = "Escalated to a human — risk was too high for an automated reply. No draft was generated.";
    resetRow.hidden = false;
    actions.hidden = true;
    draftCard.hidden = false;
    draftTitle.textContent = "Outcome";
    draftEl.hidden = true;
    attemptLabel.textContent = "";
    stepsEl.innerHTML = "";
    return;
  }

  draftEl.hidden = false;
  draftCard.hidden = false;
  draftTitle.textContent = "Reply";
  draftEl.textContent = data.draft;
  attemptLabel.textContent = `Attempt ${data.attempt} of ${data.max_attempts}`;
  renderSteps(data.attempt, data.max_attempts);

  if (data.status === "awaiting_review") {
    outcomeCard.hidden = true;
    actions.hidden = false;
    resetRow.hidden = true;
    isLastRound = data.attempt >= data.max_attempts;
    lastNote.hidden = !isLastRound;
    reviseBtn.textContent = isLastRound ? "Finish without approval" : "Request rewrite";
    feedback.value = "";
    return;
  }

  actions.hidden = true;
  resetRow.hidden = false;
  outcomeCard.hidden = false;

  if (data.status === "auto_resolved") {
    outcomeCard.className = "card banner ok";
    outcomeText.textContent = "Auto-resolved — low risk, AI reviewer approved it, no human needed.";
  } else if (data.status === "approved") {
    outcomeCard.className = "card banner ok";
    outcomeText.textContent = "Approved by human reviewer. Ready to send.";
  } else {
    outcomeCard.className = "card banner warn";
    outcomeText.textContent = "Attempt limit reached. This draft was never approved — review it manually.";
  }
}

async function start() {
  const ticket = ticketInput.value.trim();
  if (!ticket) {
    errorMsg.textContent = "Paste a ticket first.";
    return;
  }

  errorMsg.textContent = "";
  setBusy(true, "Running pipeline...");

  try {
    render(await post(START_URL, { raw_ticket: ticket }));
  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
  } finally {
    setBusy(false);
  }
}

async function respond(text, busyLabel) {
  errorMsg.textContent = "";
  setBusy(true);
  const original = reviseBtn.textContent;
  if (busyLabel) reviseBtn.textContent = busyLabel;

  try {
    render(await post(RESUME_URL, { thread_id: threadId, response: text }));
  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    reviseBtn.textContent = original;
  } finally {
    setBusy(false);
  }
}

approveBtn.addEventListener("click", () => respond("approved"));

reviseBtn.addEventListener("click", () => {
  const text = feedback.value.trim();
  if (!text && !isLastRound) {
    errorMsg.textContent = "Add some feedback so the rewrite knows what to fix.";
    return;
  }
  respond(text || "Not approved by human.", isLastRound ? "Finishing..." : "Rewriting...");
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(draftEl.textContent);
    copyBtn.textContent = "Copied";
  } catch (_) {
    copyBtn.textContent = "Copy failed";
  }
  setTimeout(() => (copyBtn.textContent = "Copy reply"), 1500);
});

resetBtn.addEventListener("click", () => {
  threadId = null;
  ticketInput.value = "";
  errorMsg.textContent = "";
  traceCard.hidden = true;
  outcomeCard.hidden = true;
  draftCard.hidden = true;
  composeCard.hidden = false;
  ticketInput.focus();
});

startBtn.addEventListener("click", start);
