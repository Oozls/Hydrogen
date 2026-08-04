import { api } from "./api.js";

// 홈 화면에서 재생을 시작하면 시드 곡 1개 + 알고리즘이 고른 곡들로 큐를 채운다.
// 이후 곡이 끝나거나 건너뛸 때마다 한 곡씩 끝에 계속 채워 넣는다("라디오").
const QUEUE_INITIAL_COUNT = 9;
const QUEUE_FAMILIAR_COUNT = 4;

// startRecommendQueue()가 초기 9곡을 받아오는 동안, 같은 큐에 대해
// setupQueueEngine()의 자동 확장이 끼어들지 않게 막는 가드. 시드 곡 1개만 있는
// 상태로 playIndex(0)이 호출되면 currentIndex(0)가 곧 마지막 인덱스라 자동 확장
// 조건과 우연히 맞아떨어지므로, 이 플래그가 없으면 초기 배치와 경쟁해 곡이 하나
// 더 끼어든다.
let seedingPlaylist = null;

// 다시 듣기/빠른 선곡에서 곡을 클릭했을 때 호출한다. 시드 곡으로 즉시 재생을
// 시작하고, 나머지 9곡은 백그라운드로 받아와 큐에 이어 붙인다.
export async function startRecommendQueue(player, track) {
  player.resetPlaybackModes();
  player.setPlaylist({ name: "재생 대기 목록", tracks: [track] }, { mode: "recommend" });
  seedingPlaylist = player.playlist;
  player.playIndex(0);

  try {
    const { items } = await api.getQueueSongs({
      seedTrackId: track.track_id,
      count: QUEUE_INITIAL_COUNT,
      familiarCount: QUEUE_FAMILIAR_COUNT,
      excludeIds: [track.track_id],
    });
    // 응답이 오는 동안 사용자가 다른 곡으로 새 큐를 또 시작했을 수 있다 — 그 경우
    // 이 결과는 더 이상 유효하지 않으므로 버린다.
    if (player.playlist && player.playlist.tracks[0] === track && items && items.length) {
      player.appendTracks(items);
    }
  } catch (_err) {
    /* 큐 확장 실패 시 시드 곡만 재생하고 조용히 넘어간다 */
  } finally {
    if (seedingPlaylist === player.playlist) seedingPlaylist = null;
  }
}

// 추천 큐(queueMode === "recommend")가 마지막 곡까지 도달할 때마다 한 곡씩 더
// 받아와 이어 붙인다. 앱 시작 시 한 번만 호출해 항상 활성 상태로 둔다 — 확장
// 화면이 열려 있지 않아도 라디오처럼 계속 이어져야 하기 때문.
export function setupQueueEngine(player) {
  let lastPlaylistRef = null;
  let queuedIds = null;
  let extending = false;

  player.addEventListener("trackchange", async () => {
    if (player.playlist !== lastPlaylistRef) {
      lastPlaylistRef = player.playlist;
      queuedIds =
        player.queueMode === "recommend" && player.playlist
          ? new Set(player.playlist.tracks.map((t) => t.track_id))
          : null;
    }
    if (player.queueMode !== "recommend" || !player.playlist || extending) return;
    if (player.playlist === seedingPlaylist) return;
    if (player.currentIndex !== player.playlist.tracks.length - 1) return;

    extending = true;
    const playlistAtRequest = player.playlist;
    try {
      const seedTrackId = playlistAtRequest.tracks[0].track_id;
      const { items } = await api.getQueueSongs({
        seedTrackId,
        count: 1,
        excludeIds: Array.from(queuedIds),
      });
      if (player.playlist === playlistAtRequest && items && items.length) {
        player.appendTracks(items);
        items.forEach((t) => queuedIds.add(t.track_id));
      }
    } catch (_err) {
      /* 다음 곡을 못 받아오면 조용히 무시 — 재생은 마지막 곡에서 멈춘다 */
    } finally {
      extending = false;
    }
  });
}

// 확장 화면에서 "앞으로 재생될 곡" 목록을 그리기 위한 순수 함수. queueMode에
// 따라 계산 방식이 다르다 — recommend는 이미 평평한 배열이라 그대로 자르면 되고,
// list는 셔플/전곡반복 상태를 반영해 재구성해야 한다.
export function getDisplayQueue(player) {
  if (!player.playlist || player.currentIndex < 0) return [];
  const tracks = player.playlist.tracks;
  const n = tracks.length;
  if (!n) return [];

  if (player.queueMode === "recommend") {
    return tracks.slice(player.currentIndex);
  }

  if (player.shuffle && player.shuffleOrder.length) {
    const pos = player.shuffleOrder.indexOf(player.currentIndex);
    const order = pos >= 0 ? player.shuffleOrder.slice(pos) : [player.currentIndex];
    return order.map((i) => tracks[i]);
  }

  const forward = tracks.slice(player.currentIndex);
  if (player.repeatMode === "all") {
    return forward.concat(tracks.slice(0, player.currentIndex));
  }
  return forward;
}
