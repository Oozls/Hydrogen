import { api } from "./api.js";

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function fmtBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes || 0;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

// 글로벌 플레이리스트 재작성 결과(중복 정리/스킵 내역)를 보여주는 다이얼로그.
// 여기 나오는 중복은 태그뿐 아니라 파일 내용 해시까지 같다고 서버가 이미
// 확정해 data/trash로 옮긴 것들이라, 사람이 따로 결정할 건 없고 무엇이
// 정리됐는지 확인 + 미리듣기만 할 수 있으면 된다(옮겨진 파일도 재생 가능).
export function setupRebuildResultDialog() {
  const dialogEl = document.getElementById("rebuild-result-dialog");
  const closeBtn = document.getElementById("rebuild-result-close");
  const summaryEl = document.getElementById("rebuild-result-summary");
  const duplicatesEl = document.getElementById("rebuild-result-duplicates");
  const skippedEl = document.getElementById("rebuild-result-skipped");

  closeBtn.addEventListener("click", () => dialogEl.close());

  function buildFileRow(file, kept) {
    const row = document.createElement("div");
    row.className = "rebuild-dup-file" + (kept ? " kept" : "");

    const info = document.createElement("div");
    info.className = "rebuild-dup-file-info";
    const badge = document.createElement("span");
    badge.className = "rebuild-dup-badge";
    badge.textContent = kept ? "유지됨" : "휴지통으로 이동됨";
    const meta = document.createElement("span");
    meta.className = "rebuild-dup-file-meta";
    meta.textContent = `${file.filename} · ${fmtDuration(file.duration_ms)} · ${fmtBytes(file.size_bytes)}`;
    info.appendChild(badge);
    info.appendChild(meta);

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = api.songFileAudioUrl(file.filename);

    row.appendChild(info);
    row.appendChild(audio);
    return row;
  }

  function buildDuplicateGroup(dup) {
    const card = document.createElement("div");
    card.className = "rebuild-dup-group";

    const title = document.createElement("div");
    title.className = "rebuild-dup-title";
    title.textContent = dup.title || "(제목 없음)";
    const meta = document.createElement("div");
    meta.className = "rebuild-dup-meta";
    meta.textContent = [dup.circle, dup.album, dup.artist].filter(Boolean).join(" · ");

    const filesEl = document.createElement("div");
    filesEl.className = "rebuild-dup-files";
    filesEl.appendChild(buildFileRow(dup.kept_file, true));
    dup.moved_files.forEach((file) => filesEl.appendChild(buildFileRow(file, false)));

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(filesEl);
    return card;
  }

  function buildSection(count, titleText, buildRows) {
    if (!count) return null;
    const section = document.createElement("div");
    section.className = "rebuild-result-section";
    const heading = document.createElement("div");
    heading.className = "rebuild-section-title";
    heading.textContent = titleText;
    section.appendChild(heading);
    buildRows(section);
    return section;
  }

  function buildSkipRow(skip) {
    const row = document.createElement("div");
    row.className = "rebuild-skip-row";
    const name = document.createElement("span");
    name.className = "rebuild-skip-filename";
    name.textContent = skip.filename;
    const reason = document.createElement("span");
    reason.className = "rebuild-skip-reason";
    reason.textContent = skip.reason;
    row.appendChild(name);
    row.appendChild(reason);
    return row;
  }

  function open(result) {
    summaryEl.textContent = `${result.track_count}곡으로 재작성했습니다.`;

    duplicatesEl.innerHTML = "";
    const dupSection = buildSection(
      result.duplicates.length,
      `내용까지 동일해 정리한 중복: ${result.duplicates.length}곡`,
      (section) => result.duplicates.forEach((dup) => section.appendChild(buildDuplicateGroup(dup)))
    );
    if (dupSection) duplicatesEl.appendChild(dupSection);

    skippedEl.innerHTML = "";
    const skipSection = buildSection(
      result.skipped.length,
      `읽지 못해 건너뛴 파일: ${result.skipped.length}개`,
      (section) => result.skipped.forEach((skip) => section.appendChild(buildSkipRow(skip)))
    );
    if (skipSection) skippedEl.appendChild(skipSection);

    dialogEl.showModal();
  }

  return { open };
}
