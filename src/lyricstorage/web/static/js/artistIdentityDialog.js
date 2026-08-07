import { api } from "./api.js";
import { alertDialog } from "./dialog.js";
import { splitArtists } from "./songArtist.js";
import { buildAutocomplete } from "./autocomplete.js";

// 정체성(대표 이름 + 이명)을 수정하는 다이얼로그(#artist-info-dialog)는 재생
// 통계 '곡 아티스트' 탭, 브라우즈 '곡 아티스트' 탭, 브라우즈 '아티스트'(서클) 탭이
// 화면 하나(같은 DOM)를 공유한다. 각 화면이 이벤트 리스너를 따로 붙이면 중복
// 실행되므로, 이 모듈이 DOM 바인딩을 한 번만 하고 open()으로 호출자별 상태(현재
// 정체성, API 엔드포인트, 콜백)만 갈아 끼운다. 곡 아티스트/서클은 저장 파일만
// 다를 뿐 정체성 CRUD 로직 자체는 동일해서(identity_registry.py 공유) 엔드포인트
// 함수 4개만 바꿔 끼우면 그대로 재사용된다.
const ARTIST_ENDPOINTS = {
  rename: (id, name) => api.renameArtist(id, name),
  addAlias: (id, alias) => api.addArtistAlias(id, alias),
  removeAlias: (id, alias) => api.removeArtistAlias(id, alias),
};

export function setupArtistIdentityDialog() {
  const dialog = document.getElementById("artist-info-dialog");
  const titleEl = document.getElementById("artist-info-title");
  const nameInput = document.getElementById("artist-info-name");
  const aliasesEl = document.getElementById("artist-info-aliases");
  const aliasInput = document.getElementById("artist-info-alias-input");
  const aliasAddBtn = document.getElementById("artist-info-alias-add");
  const suggestionsEl = document.getElementById("artist-alias-suggestions");
  const cancelBtn = document.getElementById("artist-info-cancel");
  const saveBtn = document.getElementById("artist-info-save");

  let identity = null;
  let onChange = null;
  let getTracks = null;
  let endpoints = ARTIST_ENDPOINTS;
  let aliasCandidates = [];

  const aliasAutocomplete = buildAutocomplete(aliasInput, suggestionsEl, () => aliasCandidates);

  function renderChips() {
    aliasesEl.innerHTML = "";
    identity.aliases.forEach((alias) => {
      const chip = document.createElement("span");
      chip.className = "artist-alias-chip";
      chip.appendChild(document.createTextNode(alias));
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "artist-alias-chip-remove";
      removeBtn.title = "이명 삭제";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", async () => {
        try {
          identity = await endpoints.removeAlias(identity.id, alias);
          onChange(identity);
          renderChips();
          populateSuggestions();
        } catch (err) {
          await alertDialog(err.message);
        }
      });
      chip.appendChild(removeBtn);
      aliasesEl.appendChild(chip);
    });
  }

  // 이명 입력창 자동완성 후보 — 지금 화면(통계/브라우즈)의 곡 목록에 실제로
  // 쓰인 아티스트 이름 중 이미 이 정체성의 대표 이름/이명인 것은 뺀다.
  async function populateSuggestions() {
    const known = new Set([identity.name, ...identity.aliases]);
    const tracks = (await getTracks()) || [];
    const names = new Set();
    for (const track of tracks) {
      for (const name of splitArtists(track.artist)) {
        if (!known.has(name)) names.add(name);
      }
    }
    aliasCandidates = [...names].sort((a, b) => a.localeCompare(b, "ko"));
  }

  aliasAddBtn.addEventListener("click", async () => {
    const alias = aliasInput.value.trim();
    if (!alias) return;
    try {
      identity = await endpoints.addAlias(identity.id, alias);
      onChange(identity);
      aliasInput.value = "";
      aliasAutocomplete.hide();
      renderChips();
      populateSuggestions();
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  cancelBtn.addEventListener("click", () => dialog.close());

  saveBtn.addEventListener("click", async () => {
    const newName = nameInput.value.trim();
    if (!newName) {
      await alertDialog("아티스트 이름을 입력하세요.");
      return;
    }
    try {
      if (newName !== identity.name) {
        identity = await endpoints.rename(identity.id, newName);
        onChange(identity);
      }
      dialog.close();
    } catch (err) {
      await alertDialog(err.message);
    }
  });

  return {
    // getTracks: () => Track[] | Promise<Track[]> — 자동완성 후보를 뽑을 곡 목록.
    // onChange(identity): 이름/이명이 바뀔 때마다(다이얼로그가 열려있는 동안) 호출.
    // onClose(): 다이얼로그를 닫을 때(취소든 저장이든) 한 번 호출 — 호출자가 자기
    // 화면의 상세 목록을 최신 정체성 기준으로 다시 그리는 데 쓴다.
    // endpoints: {rename, addAlias, removeAlias} — 곡 아티스트(기본값)가 아니라
    // 서클을 수정할 땐 circles.js의 대응 API로 갈아 끼운다.
    // title: 다이얼로그 제목(기본 "아티스트 정보 수정").
    open(initialIdentity, { getTracks: tracksFn, onChange: onChangeCb, onClose, endpoints: endpointsOverride, title }) {
      identity = initialIdentity;
      onChange = onChangeCb;
      getTracks = tracksFn;
      endpoints = endpointsOverride || ARTIST_ENDPOINTS;
      titleEl.textContent = title || "아티스트 정보 수정";
      nameInput.value = identity.name;
      aliasInput.value = "";
      aliasAutocomplete.hide();
      renderChips();
      populateSuggestions();
      dialog.showModal();
      const handleClose = () => {
        dialog.removeEventListener("close", handleClose);
        if (onClose) onClose();
      };
      dialog.addEventListener("close", handleClose);
    },
  };
}
