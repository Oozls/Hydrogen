import { api } from "./api.js";

// 홈 화면에서 재생을 시작하면 시드 곡 1개 + 알고리즘이 고른 곡들로 큐를 채운다.
// 이후 곡이 바뀔 때마다, 지금 재생 중인 곡 뒤로 항상 QUEUE_AHEAD_COUNT곡만큼
// 남아있도록 부족한 만큼만 끝에 채워 넣는다("라디오").
const QUEUE_INITIAL_COUNT = 9;
const QUEUE_FAMILIAR_COUNT = 4;
const QUEUE_AHEAD_COUNT = 9;

// startRecommendQueue()가 초기 9곡을 받아오는 동안, 같은 큐에 대해
// setupQueueEngine()의 자동 확장이 끼어들지 않게 막는 가드. 시드 곡 1개만 있는
// 상태로 playIndex(0)이 호출되면 currentIndex(0)가 곧 마지막 인덱스라 자동 확장
// 조건과 우연히 맞아떨어지므로, 이 플래그가 없으면 초기 배치와 경쟁해 곡이 하나
// 더 끼어든다.
let seedingPlaylist = null;

// 다시 듣기/빠른 선곡에서 곡을 클릭했을 때 호출한다. 시드 곡으로 즉시 재생을
// 시작하고, 나머지 9곡은 백그라운드로 받아와 큐에 이어 붙인다.
export async function startRecommendQueue(player, track) {
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

// 추천 큐(queueMode === "recommend")는 곡이 바뀔 때마다(끝나서 넘어가든 건너뛰든)
// 지금 재생 중인 곡 뒤로 QUEUE_AHEAD_COUNT곡이 남도록 부족한 개수만큼 받아와
// 끝에 이어 붙인다. 한 곡씩만 더하던 예전 방식과 달리, 큐 안의 곡을 직접 눌러
// 여러 칸을 한 번에 건너뛴 경우에도 모자란 만큼을 한 번에 채운다.
// 앱 시작 시 한 번만 호출해 항상 활성 상태로 둔다 — 확장 화면이 열려 있지
// 않아도 라디오처럼 계속 이어져야 하기 때문.
export function setupQueueEngine(player) {
  let extending = false;

  player.addEventListener("trackchange", async () => {
    if (player.queueMode !== "recommend" || !player.playlist || extending) return;
    if (player.playlist === seedingPlaylist) return;

    const playlistAtRequest = player.playlist;
    const deficit = player.currentIndex + 1 + QUEUE_AHEAD_COUNT - playlistAtRequest.tracks.length;
    if (deficit <= 0) return;

    extending = true;
    try {
      const seedTrackId = playlistAtRequest.tracks[0].track_id;
      // 큐에 이미 들어간 곡 id는 매번 지금 playlist.tracks에서 새로 뽑는다 —
      // 별도 캐시(Set)를 따로 두면, 시작 시 받아온 초기 9곡처럼 이 리스너가
      // 모르는 사이에 채워진 곡들이 제외 목록에서 빠져 중복 추천될 수 있다.
      const excludeIds = playlistAtRequest.tracks.map((t) => t.track_id);
      const { items } = await api.getQueueSongs({
        seedTrackId,
        count: deficit,
        excludeIds,
      });
      if (player.playlist === playlistAtRequest && items && items.length) {
        player.appendTracks(items);
      }
    } catch (_err) {
      /* 다음 곡을 못 받아오면 조용히 무시 — 재생은 마지막 곡에서 멈춘다 */
    } finally {
      extending = false;
    }
  });
}

// 확장 화면에서 "재생 대기 목록"에 보여줄 곡 목록을 그리기 위한 순수 함수.
// 셔플 상태는 recommend/list 공통으로 반영한다. 전곡반복으로 앞부분을 다시
// 이어붙이는 동작만 recommend(계속 늘어나는 목록이라 "전체를 한 바퀴 더 돈다"는
// 개념이 없다)에서는 제외한다.
//
// 목록은 재생이 시작된 지점("앵커")부터 보여주고, 곡이 끝나거나 건너뛰어도
// currentIndex를 따라 슬라이딩 윈도우처럼 줄어들지 않는다 — 앵커는 이 playlist
// 객체에 한 번만 기록해두고 계속 재사용한다(끝난 곡도 목록에 남아있어야
// 한다는 요구사항). 셔플+전곡반복 재섞임처럼 옛 앵커로는 지금 재생 중인 곡을
// 더 이상 포함할 수 없게 되는 경우에만(예: 새로 섞인 순서에서 앵커의 위치가
// 지금 위치보다 뒤로 밀림) 지금 곡을 새 앵커로 다시 잡아 "새 바퀴"를 시작한다.
function buildQueueFrom(player, anchor) {
  const tracks = player.playlist.tracks;
  if (player.shuffle && player.shuffleOrder.length) {
    const pos = player.shuffleOrder.indexOf(anchor);
    const order = pos >= 0 ? player.shuffleOrder.slice(pos) : [anchor];
    return order.map((i) => tracks[i]);
  }
  const forward = tracks.slice(anchor);
  if (player.queueMode !== "recommend" && player.repeatMode === "all") {
    return forward.concat(tracks.slice(0, anchor));
  }
  return forward;
}

export function getDisplayQueue(player) {
  if (!player.playlist || player.currentIndex < 0) return [];
  const playlist = player.playlist;
  if (!playlist.tracks.length) return [];

  if (playlist._queueAnchor == null) playlist._queueAnchor = player.currentIndex;
  let queue = buildQueueFrom(player, playlist._queueAnchor);
  if (!queue.includes(player.currentTrack)) {
    playlist._queueAnchor = player.currentIndex;
    queue = buildQueueFrom(player, playlist._queueAnchor);
  }
  return queue;
}
