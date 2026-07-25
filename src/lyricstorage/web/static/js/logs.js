async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} 요청 실패 (${res.status})`);
  return res.json();
}

const selectEl = document.getElementById("logs-period-select");
const listEl = document.getElementById("logs-list");
const refreshBtn = document.getElementById("logs-refresh-btn");
const panelEl = document.querySelector(".logs-list-panel");

function scrollToBottom() {
  panelEl.scrollTop = panelEl.scrollHeight;
}

function periodLabel(file) {
  const half = file.half === "AM" ? "오전 (00:00~12:00)" : "오후 (12:00~24:00)";
  return `${file.date} ${half}`;
}

function renderEmpty(message) {
  listEl.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "logs-empty";
  empty.textContent = message;
  listEl.appendChild(empty);
}

function renderEntries(entries) {
  listEl.innerHTML = "";
  if (!entries.length) {
    renderEmpty("이 구간에는 기록된 로그가 없습니다.");
    return;
  }
  // 시간순(오래된 것 → 최신)으로 표시하고, 최신 항목이 있는 하단으로 스크롤한다.
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `log-row log-level-${entry.level.toLowerCase()}`;

    const ts = document.createElement("span");
    ts.className = "log-ts";
    ts.textContent = entry.timestamp;
    row.appendChild(ts);

    const badge = document.createElement("span");
    badge.className = "log-badge";
    badge.textContent = entry.level;
    row.appendChild(badge);

    const category = document.createElement("span");
    category.className = "log-category";
    category.textContent = entry.category;
    row.appendChild(category);

    const message = document.createElement("pre");
    message.className = "log-message";
    message.textContent = entry.message;
    row.appendChild(message);

    listEl.appendChild(row);
  }
  scrollToBottom();
}

async function loadEntries(date, half) {
  renderEmpty("불러오는 중...");
  try {
    const data = await fetchJSON(`/api/logs/${date}/${half}`);
    renderEntries(data.entries);
  } catch (err) {
    renderEmpty(err.message);
  }
}

async function loadPeriods(preserveSelection) {
  const previous = preserveSelection ? selectEl.value : null;
  const files = await fetchJSON("/api/logs");
  selectEl.innerHTML = "";

  if (!files.length) {
    const opt = document.createElement("option");
    opt.textContent = "기록된 로그가 없습니다";
    opt.disabled = true;
    selectEl.appendChild(opt);
    renderEmpty("아직 기록된 로그가 없습니다.");
    return;
  }

  for (const file of files) {
    const opt = document.createElement("option");
    opt.value = `${file.date}/${file.half}`;
    opt.textContent = periodLabel(file);
    selectEl.appendChild(opt);
  }

  const target = previous && [...selectEl.options].some((o) => o.value === previous) ? previous : selectEl.options[0].value;
  selectEl.value = target;
  const [date, half] = target.split("/");
  await loadEntries(date, half);
}

selectEl.addEventListener("change", () => {
  const [date, half] = selectEl.value.split("/");
  loadEntries(date, half);
});

refreshBtn.addEventListener("click", () => loadPeriods(true));

loadPeriods(false);
