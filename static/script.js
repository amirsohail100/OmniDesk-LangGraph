const START_URL = "/api/start";
const RESUME_URL = "/api/resume";

const $ = (id) => document.getElementById(id);

const ticketInput = $("ticket");
const charCount = $("charCount");
const startBtn = $("startBtn");
const startBtnLabel = $("startBtnLabel");
const errorMsg = $("errorMsg");

const readout = $("readout");
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
const reviewLabel = $("reviewLabel");

let threadId = null;
let isLastRound = false;

const RISK_LABELS = { toxicity_level: "Toxicity", fraud_risk: "Fraud", pr_risk: "PR / legal" };

// ---------------------------------------------------------------------------
// Input niceties: auto-growing textarea, live character count, ⌘/Ctrl+Enter
// ---------------------------------------------------------------------------

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

ticketInput.addEventListener("input", () => {
  autoGrow(ticketInput);
  charCount.textContent = `${ticketInput.value.length} / 4000`;
});

ticketInput.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") start();
});

// ---------------------------------------------------------------------------
// Pipeline diagram
// ---------------------------------------------------------------------------

const ALL_NODE_IDS = ["node-intake", "node-classify", "node-toxicity", "node-fraud", "node-pr", "node-triage", "node-escalate", "node-drafter", "node-review", "node-done"];
const ALL_LINK_IDS = ["line-ic", "line-ct", "line-cf", "line-cp", "line-tt", "line-ft", "line-pt", "line-te", "line-td", "line-dr", "line-rd", "line-ed", "line-rdone"];

function resetDiagram() {
  [...ALL_NODE_IDS, ...ALL_LINK_IDS].forEach((id) => {
    const el = $(id);
    el.classList.remove("active", "done", "escalated");
  });
}

function mark(ids, cls) {
  ids.forEach((id) => $(id).classList.add(cls));
}

let processingTimers = [];

function animateProcessing() {
  resetDiagram();
  processingTimers.forEach(clearTimeout);
  processingTimers = [];

  const stages = [
    ["node-intake"],
    ["line-ic", "node-classify"],
    ["line-ct", "line-cf", "line-cp", "node-toxicity", "node-fraud", "node-pr"],
    ["line-tt", "line-ft", "line-pt", "node-triage"],
  ];

  stages.forEach((ids, i) => {
    processingTimers.push(setTimeout(() => mark(ids, "active"), i * 320));
  });
}

function settleDiagram(data) {
  processingTimers.forEach(clearTimeout);

  const alwaysRun = ["node-intake", "line-ic", "node-classify", "line-ct", "line-cf", "line-cp", "node-toxicity", "node-fraud", "node-pr", "line-tt", "line-ft", "line-pt", "node-triage"];
  alwaysRun.forEach((id) => {
    $(id).classList.remove("active");
    $(id).classList.add("done");
  });

  if (data.status === "escalated") {
    mark(["line-te", "node-escalate"], "active");
    $("node-escalate").classList.add("escalated");
    mark(["line-ed", "node-done"], "done");
    return;
  }

  mark(["line-td", "node-drafter"], "done");
  reviewLabel.textContent = data.category && data.risk_level === "Low" ? "AI review" : "Review";

  if (data.status === "awaiting_review") {
    mark(["line-dr", "node-review"], "active");
    return;
  }

  mark(["line-dr", "node-review"], "done");
  mark(["line-rdone", "node-done"], "done");
}

function animateRetry() {
  mark(["line-rd"], "active");
  setTimeout(() => {
    $("line-rd").classList.remove("active");
    mark(["node-drafter", "line-dr", "node-review"], "active");
  }, 500);
}

// ---------------------------------------------------------------------------
// API + state rendering
// ---------------------------------------------------------------------------

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
  startBtnLabel.textContent = busy ? (label || "Running...") : "Run pipeline";
}

function barColor(score) {
  if (score >= 70) return "var(--danger)";
  if (score >= 35) return "var(--warn)";
  return "var(--ok)";
}

function renderTrace(data) {
  badgesEl.innerHTML = "";
  barsEl.innerHTML = "";

  const riskClass = `risk-${data.risk_level.toLowerCase()}`;
  const chip = (text, cls) => {
    const span = document.createElement("span");
    span.className = `badge ${cls || ""}`.trim();
    span.textContent = text;
    badgesEl.appendChild(span);
  };
  chip(data.category);
  chip(`${data.risk_level} risk`, riskClass);

  Object.entries(data.risk_scores || {}).forEach(([key, score]) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span class="bar-label">${RISK_LABELS[key] || key}</span>
      <span class="bar-track"><span class="bar-fill"></span></span>
      <span class="bar-value">${score}</span>
    `;
    barsEl.appendChild(row);
    // Set the width on the next frame so the CSS transition actually animates it.
    requestAnimationFrame(() => {
      const fill = row.querySelector(".bar-fill");
      fill.style.width = `${score}%`;
      fill.style.background = barColor(score);
    });
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

function render(data, { isRetry } = {}) {
  threadId = data.thread_id;
  readout.hidden = false;
  renderTrace(data);

  if (isRetry) animateRetry();
  settleDiagram(data);

  if (data.status === "escalated") {
    draftCard.hidden = false;
    draftTitle.textContent = "Outcome";
    draftEl.hidden = true;
    actions.hidden = true;
    resetRow.hidden = false;
    attemptLabel.textContent = "";
    stepsEl.innerHTML = "";
    outcomeCard.hidden = false;
    outcomeCard.className = "banner danger";
    outcomeText.textContent = "Escalated to a human — risk was too high for an automated reply. No draft was generated.";
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
    outcomeCard.className = "banner ok";
    outcomeText.textContent = "Auto-resolved — low risk, AI reviewer approved it, no human needed.";
  } else if (data.status === "approved") {
    outcomeCard.className = "banner ok";
    outcomeText.textContent = "Approved by human reviewer. Ready to send.";
  } else {
    outcomeCard.className = "banner warn";
    outcomeText.textContent = "Attempt limit reached. This draft was never approved — review it manually.";
  }
}

async function start() {
  const ticket = ticketInput.value.trim();
  if (!ticket) {
    errorMsg.textContent = "Paste a ticket first.";
    ticketInput.focus();
    return;
  }

  errorMsg.textContent = "";
  readout.hidden = true;
  setBusy(true, "Running pipeline...");
  animateProcessing();

  try {
    render(await post(START_URL, { raw_ticket: ticket }));
  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    resetDiagram();
  } finally {
    setBusy(false);
  }
}

async function respond(text, busyLabel, isRetry) {
  errorMsg.textContent = "";
  setBusy(true);
  const original = reviseBtn.textContent;
  if (busyLabel) reviseBtn.textContent = busyLabel;

  try {
    render(await post(RESUME_URL, { thread_id: threadId, response: text }), { isRetry });
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
  respond(text || "Not approved by human.", isLastRound ? "Finishing..." : "Rewriting...", !isLastRound);
});

copyBtn.addEventListener("click", async () => {
  const original = copyBtn.textContent;
  try {
    await navigator.clipboard.writeText(draftEl.textContent);
    copyBtn.textContent = "Copied";
  } catch (_) {
    copyBtn.textContent = "Copy failed";
  }
  setTimeout(() => (copyBtn.textContent = original === "Copied" ? "Copy reply" : original), 1500);
});

resetBtn.addEventListener("click", () => {
  threadId = null;
  ticketInput.value = "";
  autoGrow(ticketInput);
  charCount.textContent = "0 / 4000";
  errorMsg.textContent = "";
  readout.hidden = true;
  resetDiagram();
  ticketInput.focus();
});

startBtn.addEventListener("click", start);
