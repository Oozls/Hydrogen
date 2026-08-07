export function distinctValues(tracks, field) {
  const seen = new Set();
  const values = [];
  for (const track of tracks) {
    const value = (track[field] || "").trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push(value);
  }
  return values;
}

// 입력칸 아래 커스텀 자동완성 목록. 필드별로 독립적으로 동작하며(다른 필드는
// 건드리지 않음), 항목 선택은 blur보다 먼저 발생하는 mousedown으로 처리한다.
export function buildAutocomplete(inputEl, listEl, getValues) {
  let highlighted = -1;

  function hide() {
    listEl.hidden = true;
    listEl.innerHTML = "";
    highlighted = -1;
  }

  // <dialog>는 내용이 넘치면 자기 자신을 스크롤하는 UA 기본 동작이 있어서,
  // 목록을 dialog 안에서 position:absolute로 두면 다이얼로그 크기에 잘려
  // 스크롤해야만 보인다. position:fixed + 뷰포트 좌표로 직접 배치하면
  // dialog의 overflow 클리핑을 벗어나 화면 위에 그대로 뜬다.
  function position() {
    const rect = inputEl.getBoundingClientRect();
    listEl.style.left = `${rect.left}px`;
    listEl.style.top = `${rect.bottom}px`;
    listEl.style.width = `${rect.width}px`;
  }

  function select(value) {
    inputEl.value = value;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    hide();
  }

  function render() {
    const query = inputEl.value.trim().toLowerCase();
    let matches = getValues().filter((v) => v.toLowerCase().includes(query));
    if (matches.length === 1 && matches[0].toLowerCase() === query) {
      matches = [];
    }

    listEl.innerHTML = "";
    if (!matches.length) {
      hide();
      return;
    }
    position();
    matches.forEach((value, i) => {
      const li = document.createElement("li");
      li.className = "picker-row";
      li.textContent = value;
      if (i === highlighted) li.classList.add("highlighted");
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        select(value);
      });
      listEl.appendChild(li);
    });
    listEl.hidden = false;
  }

  inputEl.addEventListener("input", () => {
    highlighted = -1;
    render();
  });
  inputEl.addEventListener("focus", render);
  inputEl.addEventListener("blur", hide);
  inputEl.addEventListener("keydown", (e) => {
    if (listEl.hidden) return;
    const items = [...listEl.children];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, items.length - 1);
      items.forEach((li, i) => li.classList.toggle("highlighted", i === highlighted));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      items.forEach((li, i) => li.classList.toggle("highlighted", i === highlighted));
    } else if (e.key === "Enter" && highlighted >= 0) {
      e.preventDefault();
      select(items[highlighted].textContent);
    } else if (e.key === "Escape") {
      hide();
    }
  });

  return { hide };
}
