// 波点音乐 (Bodian) for MyGo Music.
//
// Bodian is Kuwo's music app: its API answers JSON under bd-api.kuwo.cn,
// with headers naming the app, and a session whose token is bound to this
// install's device ID. The plugin keeps both in host.storage.

const API = "https://bd-api.kuwo.cn/api/";
const LYRIC = "https://mlyric.kuwo.cn/mobi.s";
const UA = "Dart/3.3 (dart:io)";
const PAGE = 30;
const PLAYLIST_LIMIT = 1000;
const SESSION_KEY = "session";
const DEVID_KEY = "devid";

// Which of Bodian's list sources a playlist is in.
const SOURCE_OTHERS = 4; // playlists listeners made public
const SOURCE_OWN = 5; // the listener's own
const SOURCE_ALBUM = 6; // saved albums
const SOURCE_ARTIST = 7; // followed artists
const SOURCE_LIKED = 13;

// The envelope's code for a session Bodian no longer takes.
const SIGNED_OUT = [-101, 11012];
const NO_STREAM = [20012, 20018, 20019];

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

// --- storage ---------------------------------------------------------------

// devid is this install's device ID: Bodian trusts a device it has seen
// before, and a token is only good on the device it was issued to.
function devid() {
  let id = host.storage.get(DEVID_KEY);
  if (!id) {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    host.storage.set(DEVID_KEY, id);
  }
  return id;
}

function session() {
  return host.storage.get(SESSION_KEY) || null;
}

function setSession(value) {
  if (value) host.storage.set(SESSION_KEY, value);
  else host.storage.remove(SESSION_KEY);
}

async function requireSession() {
  const s = session();
  if (!s) throw fail("signIn", "请先扫码登录波点音乐");
  return s;
}

// --- requests --------------------------------------------------------------

function headers(extra) {
  const h = {
    "User-Agent": UA,
    plat: "win",
    channel: "W1",
    ver: "1.1.7",
    svrver: "13",
    "api-ver": "application/json",
    brand: "Windows",
    net: "wifi",
    devid: devid(),
    qimei36: devid(),
    ...extra,
  };
  const s = session();
  if (s) {
    h.uid = String(s.uid);
    h.token = s.token;
  }
  return h;
}

async function request(path, { query, method = "GET", body, headers: extra } = {}) {
  let url = API + path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  // Bodian's writes, and some of its reads, take the session in the query
  // as well as the headers.
  const s = session();
  if (s) {
    q.set("uid", String(s.uid));
    q.set("token", s.token);
  }
  const text = q.toString();
  if (text) url += `?${text}`;
  const init = { method, headers: headers(extra) };
  if (body !== undefined) {
    init.method = method === "GET" ? "POST" : method;
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  init.signal = controller.signal;
  let envelope;
  try {
    const response = await fetch(url, init);
    envelope = await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("波点音乐请求超时，请稍后重试");
    throw new Error("无法读取波点音乐，请检查网络后重试");
  } finally {
    clearTimeout(timer);
  }
  if (!envelope || typeof envelope !== "object") throw new Error("波点音乐返回了无效数据");
  const code = Number(envelope.code);
  if (code !== 200) {
    if (SIGNED_OUT.includes(code)) {
      setSession(null);
      throw fail("signIn", "波点音乐登录已失效，请重新扫码登录");
    }
    if (NO_STREAM.includes(code)) throw fail("unavailable", "波点音乐没有这首歌曲的播放权限");
    throw new Error(`波点音乐接口返回错误（${Number.isFinite(code) ? code : "未知"}）`);
  }
  return envelope.data;
}

const get = (path, query, extra) => request(path, { query, ...extra });
const post = (path, body, extra) => request(path, { method: "POST", body, ...extra });

// --- IDs -------------------------------------------------------------------
// MyGo Music IDs are strings of the source's own; ours say what kind of
// thing they name, and a playlist also which of Bodian's lists it's in.

const plID = (source, raw) => `pl-${source || 0}-${raw}`;
const bangID = (raw) => `bang-${raw}`;
const albumID = (raw) => `al-${raw}`;
const artistID = (raw) => `ar-${raw}`;

function digits(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || Number(text) <= 0) throw fail("unavailable", "无效的波点音乐 ID");
  return text;
}

function parsePrefixed(value, prefix) {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(value ?? ""));
  if (!m) throw fail("unavailable", "无效的波点音乐 ID");
  return m[1];
}

function parsePlaylistID(value) {
  const m = /^pl-(\d+)-(\d+)$/.exec(String(value ?? ""));
  if (!m) throw fail("unavailable", "无效的波点音乐歌单");
  return { source: Number(m[1]), raw: m[2] };
}

// --- mapping ---------------------------------------------------------------

function artistOf(id, name, image) {
  return { id: artistID(id), name: name || "", imageUrl: image || "" };
}

function toArtist(wire = {}) {
  return artistOf(wire.id || wire.artistId, wire.name, wire.pic);
}

function toAlbum(wire = {}) {
  const id = wire.albumId || wire.id || "";
  const artists = Array.isArray(wire.artists) && wire.artists.length
    ? wire.artists.map(toArtist)
    : wire.artist
      ? [artistOf(wire.artistId, wire.artist)]
      : [];
  return {
    id: id ? albumID(id) : "",
    name: wire.album || wire.name || "",
    imageUrl: wire.albumPic || wire.pic || "",
    artists,
    released: /^\d{4}-\d{2}-\d{2}$/.test(String(wire.showtime || "")) ? wire.showtime : "",
  };
}

function toTrack(wire = {}) {
  const artists = Array.isArray(wire.artists) && wire.artists.length
    ? wire.artists.map(toArtist)
    : wire.artist
      ? [artistOf(wire.artistId, wire.artist)]
      : [];
  const pay = wire.payInfo || {};
  const id = String(wire.id ?? wire.rid ?? "");
  return {
    id,
    name: wire.name || wire.songName || "",
    artists,
    album: toAlbum(wire),
    // Bodian counts seconds, MyGo Music milliseconds.
    duration: Math.max(0, Number(wire.duration) || 0) * 1000,
    url: `https://www.kuwo.cn/play_detail/${id}`,
    unavailable: wire.online === 0 || pay.cannotOnlinePlay === 1,
  };
}

function toPlaylist(wire = {}) {
  const source = Number(wire.sourceType ?? wire.source ?? 0);
  const raw = wire.id ?? wire.playlistId ?? "";
  return {
    id: plID(source, raw),
    name: wire.name || wire.title || "",
    imageUrl: wire.pic || wire.cover || "",
    description: wire.description || "",
    owner: wire.creatorName || wire.creator_name || wire.nickname || "",
    trackCount: Number(wire.musicCount ?? wire.musicnum ?? wire.total) || 0,
    saved: source === SOURCE_OTHERS && !!wire.collect,
  };
}

function toChart(wire = {}) {
  return {
    id: bangID(wire.id),
    name: wire.name || "",
    imageUrl: wire.pic || "",
    description: wire.pub ? `更新：${wire.pub}` : "",
    trackCount: Number(wire.total) || (Array.isArray(wire.musics) ? wire.musics.length : 0),
  };
}

function toComment(wire = {}) {
  const user = wire.userInfo || {};
  return {
    id: String(wire.id ?? ""),
    author: user.nickname || wire.nickname || "",
    avatarUrl: user.headImg || wire.headImg || "",
    text: wire.content || "",
    time: commentTime(wire.createTime),
    likes: Number(wire.likeCount) || 0,
    liked: Number(wire.like) !== 0,
  };
}

function commentTime(text) {
  const t = Date.parse(String(text || "").replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}

// --- base64 ----------------------------------------------------------------
// moejs has no atob/btoa: these are small, and the lyrics need UTF-8.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encode(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i) & 0xff;
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) & 0xff : 0;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) & 0xff : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < text.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < text.length ? B64[c & 63] : "=";
  }
  return out;
}

function b64decode(text) {
  const clean = String(text || "").replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => B64.indexOf(clean[i + k] || "A"));
    bytes.push(((n[0] << 2) | (n[1] >> 4)) & 0xff);
    if (i + 2 < clean.length) bytes.push(((n[1] << 4) | (n[2] >> 2)) & 0xff);
    if (i + 3 < clean.length) bytes.push(((n[2] << 6) | n[3]) & 0xff);
  }
  return utf8(bytes);
}

function utf8(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else out += String.fromCharCode(cp);
  }
  return out;
}

// --- signing in ------------------------------------------------------------

async function profileOf(uid) {
  const data = await get(`ucenter/users/pub/${uid}`, { fromUid: uid, platform: "ios" });
  const user = (data && data.userInfo) || data || {};
  return {
    id: String(user.id || uid),
    name: user.nickname || user.name || "波点音乐用户",
    imageUrl: user.headImg || user.avatar || "",
    page: "me",
  };
}

export async function signIn() {
  host.signInPrompt({ text: "正在获取波点音乐登录二维码…" });
  const { qrCode } = await get("ucenter/login/qrCode");
  if (!qrCode) throw new Error("波点音乐没有返回登录二维码，请稍后重试");
  const content = `https://bodian-oia.kuwo.cn/bodian/download.html?pageName=login_pc&pt=3&id=${encodeURIComponent(qrCode)}`;
  host.signInPrompt({ qr: content, text: "请用波点音乐 App 扫码，并在手机上确认登录" });

  const deadline = Date.now() + 180000;
  let confirmed = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let status;
    try {
      ({ status } = await get("ucenter/login/qrCodeStatus", { qrCode }));
    } catch (error) {
      continue;
    }
    if (Number(status) === 2) throw new Error("二维码已过期，请重新点击登录");
    if (Number(status) === 3) {
      confirmed = true;
      break;
    }
  }
  if (!confirmed) throw new Error("登录已取消或超时，请重新点击登录");

  // The phone confirmed it; the session may take a moment to be issued.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const data = await post("ucenter/users/login", { authType: 10, qrCode });
      const uid = data && (data.id || (data.userInfo && data.userInfo.id));
      if (!data || !data.token || !uid) throw new Error("波点音乐没有返回登录信息，请重新扫码");
      setSession({ uid: String(uid), token: data.token });
      const profile = await profileOf(uid);
      if (data.userInfo) {
        profile.name = data.userInfo.nickname || profile.name;
        profile.imageUrl = data.userInfo.headImg || profile.imageUrl;
      }
      host.signInPrompt({ text: "登录成功" });
      return profile;
    } catch (error) {
      if (error && error.code === "unavailable") throw error;
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("登录失败，请重新扫码");
}

export function signOut() {
  setSession(null);
}

export async function account() {
  const s = session();
  if (!s) return null;
  try {
    return await profileOf(s.uid);
  } catch (error) {
    if (error && error.code === "signIn") return null;
    throw error;
  }
}

// --- search ----------------------------------------------------------------

export async function search({ query, kind = "tracks", offset = 0 }) {
  const text = String(query || "").trim();
  if (!text) return { [kind]: [], more: false };
  offset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  const pn = Math.floor(offset / PAGE);
  const base = { keyword: text, pn, rn: PAGE };

  if (kind === "tracks") {
    const data = await get("search/music/list", { ...base, correct: 1 });
    const list = data.resultList || [];
    return { tracks: list.map(toTrack), more: list.length >= PAGE };
  }
  if (kind === "artists") {
    const data = await get("search/artist/list", base);
    const list = data.resultList || [];
    return { artists: list.map(toArtist), more: list.length >= PAGE };
  }
  if (kind === "albums") {
    const data = await get("search/album/list", base);
    const list = data.resultList || [];
    return { albums: list.map(toAlbum), more: list.length >= PAGE };
  }
  if (kind === "playlists") {
    const data = await get("search/playlist/list", base);
    const list = data.resultList || [];
    return { playlists: list.map(toPlaylist), more: list.length >= PAGE };
  }
  throw fail("unsupported", "波点音乐没有这种搜索");
}

export async function suggest({ query }) {
  const text = String(query || "").trim();
  if (text) return [];
  try {
    const data = await get("search/hot/list");
    return (data.resultList || []).map((w) => w.key).filter(Boolean).slice(0, 10);
  } catch (error) {
    return [];
  }
}

// --- home and pages --------------------------------------------------------

async function module(id) {
  const data = await get("service/home/module", { moduleId: id });
  return data || {};
}

async function dailySongs() {
  const data = await module(3);
  if (data.musicList && data.musicList.length) return data.musicList.map(toTrack);
  const bang = await get("service/bang/16/musics", { pn: 1, rn: 20 });
  return (bang.musics || []).map(toTrack);
}

async function charts() {
  const groups = await get("service/home/bangNew");
  const out = [];
  for (const group of groups || []) {
    for (const bang of group.bangList || []) out.push(toChart(bang));
  }
  return out;
}

async function featuredPlaylists(limit = 30) {
  const data = await module(2);
  const list = (data.songList || []).map(toPlaylist);
  return limit > 0 ? list.slice(0, limit) : list;
}

async function homeSections() {
  const sections = [];
  const [daily, lab, video, themes, featured, chartList] = await Promise.all([
    dailySongs().catch(() => []),
    module(4).catch(() => null),
    module(11).catch(() => null),
    themedSections().catch(() => []),
    featuredPlaylists(24).catch(() => []),
    charts().catch(() => []),
  ]);

  if (daily.length) {
    sections.push({
      title: "每日推荐",
      pageTitle: "每日推荐",
      subtitle: "波点音乐每天为你挑选",
      tracks: daily,
      morePage: "daily",
    });
  }
  const labMusic = lab && lab.lab && lab.lab.music;
  if (labMusic && labMusic.id) {
    const calendar = (lab.lab && lab.lab.calendar) || {};
    sections.push({
      title: calendar.title ? `波点实验室 · ${calendar.title}` : "波点实验室",
      tracks: [toTrack(labMusic)],
    });
  }
  if (video && Array.isArray(video.video) && video.video.length) {
    sections.push({ title: "听点不一样的", tracks: video.video.map(toTrack) });
  }
  sections.push(...themes);
  if (featured.length) {
    sections.push({ title: "推荐歌单", playlists: featured, morePage: "square" });
  }
  if (chartList.length) {
    sections.push({ title: "排行榜", playlists: chartList.slice(0, 8), morePage: "charts" });
  }
  return sections;
}

async function themedSections() {
  const out = [];
  const seen = new Set();
  for (const id of [12, 1]) {
    let data;
    try {
      data = await module(id);
    } catch (error) {
      continue;
    }
    for (const group of data.songList || []) {
      if (out.length === 3) return out;
      if (!group.title || !Array.isArray(group.songs) || !group.songs.length || seen.has(group.title)) continue;
      seen.add(group.title);
      out.push({ title: group.title, tracks: group.songs.map(toTrack) });
    }
  }
  return out;
}

export async function home() {
  return { title: "发现音乐", subtitle: "波点音乐 · 扫码登录后可读取你的歌单", sections: await homeSections() };
}

const SQUARE_PAGE = 60;

async function squarePage(page) {
  const pn = Math.max(1, Number(page) || 1);
  const data = await get("service/category/playlist", { pn, rn: SQUARE_PAGE });
  return { playlists: (data.playLists || []).map(toPlaylist), total: Number(data.total) || 0, pn };
}

export async function browse({ page }) {
  if (page === "daily") {
    return { title: "每日推荐", subtitle: "波点音乐每天为你挑选", sections: [{ tracks: await dailySongs() }] };
  }
  if (page === "charts") {
    return { title: "排行榜", sections: [{ playlists: await charts() }] };
  }
  if (page === "square" || /^square-\d+$/.test(String(page))) {
    const wanted = page === "square" ? 1 : Number(String(page).slice("square-".length));
    const { playlists, total, pn } = await squarePage(wanted);
    const sections = [{ title: "歌单广场", playlists }];
    const shown = (pn - 1) * SQUARE_PAGE + playlists.length;
    const links = [];
    if (shown < total) links.push({ title: "下一页", subtitle: `已看 ${shown} / ${total}`, page: `square-${pn + 1}` });
    if (pn > 1) links.push({ title: "上一页", page: `square-${pn - 1}` });
    if (links.length) sections.push({ title: "更多", links });
    return { title: "歌单广场", subtitle: "波点音乐听众公开的歌单", sections };
  }
  if (page === "me") {
    const s = await requireSession();
    const [mine, saved] = await myPlaylists(s.uid);
    const profile = await profileOf(s.uid).catch(() => null);
    return {
      title: profile ? profile.name : "我的波点音乐",
      imageUrl: profile ? profile.imageUrl : "",
      sections: [
        { title: "我的歌单", playlists: mine, empty: "还没有创建歌单" },
        { title: "收藏的歌单", playlists: saved, empty: "还没有收藏歌单" },
      ],
    };
  }
  throw fail("unsupported", "没有这个页面");
}

// --- library ---------------------------------------------------------------

async function myPlaylists(uid) {
  const data = await get("service/playlist/userCreate", { userId: uid });
  const mine = (data.playLists || []).map(toPlaylist).map((p) => ({ ...p, mine: true }));
  const saved = [];
  try {
    const collected = await get("service/collect/4/list", { userId: uid, pn: 1, rn: 100 });
    for (const p of collected.playLists || []) {
      if (Number(p.sourceType) === SOURCE_OTHERS) saved.push({ ...toPlaylist(p), saved: true });
    }
  } catch (error) {
    // Saved lists are the listener's own; a failure here leaves them out.
  }
  return [mine, saved];
}

export async function playlists() {
  const s = session();
  if (!s) return [];
  const [mine, saved] = await myPlaylists(s.uid);
  return [...mine, ...saved];
}

async function playlistSource(raw, source) {
  const path = `service/playlist/info/${raw}`;
  const tried = [];
  for (const st of [source, SOURCE_OTHERS, SOURCE_LIKED, SOURCE_OWN]) {
    if (!st || tried.includes(st)) continue;
    tried.push(st);
    let info;
    try {
      info = await get(path, { source: st });
    } catch (error) {
      continue;
    }
    if (info && info.id && info.name) return { info, source: st };
  }
  throw fail("unavailable", "歌单不存在或当前账号无权访问");
}

async function playlistTracks(raw, source) {
  const out = [];
  for (let pn = 1; pn <= 20; pn++) {
    let data;
    try {
      data = await get(`service/playlist/${raw}/musicList`, { pn, rn: PLAYLIST_LIMIT, source });
    } catch (error) {
      if (pn === 1) throw error;
      break;
    }
    const list = data.list || [];
    if (!list.length) break;
    out.push(...list.map(toTrack));
    if ((Number(data.total) > 0 && out.length >= Number(data.total)) || out.length >= PLAYLIST_LIMIT) break;
  }
  return out.slice(0, PLAYLIST_LIMIT);
}

export async function playlist({ id }) {
  if (/^bang-\d+$/.test(String(id))) {
    const raw = parsePrefixed(id, "bang");
    const data = await get(`service/bang/${raw}/musics`, { pn: 1, rn: PLAYLIST_LIMIT });
    return {
      id: bangID(raw),
      name: data.name || "排行榜",
      imageUrl: data.pic || "",
      description: data.pub ? `更新：${data.pub}` : "",
      trackCount: Number(data.total) || (data.musics || []).length,
      tracks: (data.musics || []).map(toTrack),
    };
  }
  const { source, raw } = parsePlaylistID(id);
  const { info, source: st } = await playlistSource(raw, source);
  const pl = toPlaylist(info);
  pl.id = plID(st, raw);
  pl.mine = st === SOURCE_OWN;
  pl.saved = st === SOURCE_OTHERS && !!info.collect;
  pl.tracks = await playlistTracks(raw, st);
  if (!pl.trackCount) pl.trackCount = pl.tracks.length;
  return pl;
}

export async function createPlaylist({ name }) {
  const title = String(name || "").trim();
  if (!title) throw new Error("歌单名不能为空");
  await requireSession();
  const data = await post("service/playlist", { name: title, private: false });
  const raw = data && (data.id || data.playlistId);
  if (!raw) throw new Error("波点音乐没有返回新歌单的 ID");
  return { id: plID(SOURCE_OWN, raw), name: title, mine: true, trackCount: 0, tracks: [] };
}

export async function renamePlaylist({ id, name }) {
  const title = String(name || "").trim();
  if (!title) throw new Error("歌单名不能为空");
  await requireSession();
  const { raw } = parsePlaylistID(id);
  const info = await get(`service/playlist/info/${raw}`, { source: SOURCE_OWN });
  await request("service/playlist", {
    method: "PUT",
    body: { id: Number(raw), name: title, description: info.description || "", pic: info.pic || "", categoryList: [] },
  });
}

export async function deletePlaylist({ id }) {
  await requireSession();
  const { raw } = parsePlaylistID(id);
  await request("service/playlist", { method: "DELETE", body: { playlistIds: [Number(raw)] } });
}

async function editSongs(path, id, trackIds) {
  await requireSession();
  const { raw } = parsePlaylistID(id);
  const songs = (trackIds || []).map(digits).map(Number);
  if (!songs.length) return;
  await post(path, { playListId: Number(raw), musicIdList: songs });
}

export function addToPlaylist({ id, trackIds }) {
  return editSongs("service/playlist/music", id, trackIds);
}

export function removeFromPlaylist({ id, trackIds }) {
  return editSongs("service/playlist/music/delete", id, trackIds);
}

async function collect(source, rawId, on) {
  const s = await requireSession();
  await post("service/collect", {
    source,
    sourceId: [Number(rawId)],
    op: on ? 1 : 2,
    uid: Number(s.uid),
    token: s.token,
  });
}

export async function savePlaylist({ id, on }) {
  const { raw } = parsePlaylistID(id);
  await collect(SOURCE_OTHERS, raw, on);
}

export async function saveAlbum({ id, on }) {
  await collect(SOURCE_ALBUM, parsePrefixed(id, "al"), on);
}

export async function followArtist({ id, on }) {
  await collect(SOURCE_ARTIST, parsePrefixed(id, "ar"), on);
}

async function likedPlaylistID(uid) {
  const data = await get("service/playlist/fond", { userId: uid });
  return String(data && data.id ? data.id : "");
}

let likedCache = null;

async function likedIDs(uid) {
  if (likedCache && likedCache.uid === uid && Date.now() - likedCache.at < 60000) return likedCache.ids;
  const pid = await likedPlaylistID(uid);
  if (!pid) return [];
  const ids = [];
  for (let pn = 1; pn <= 100; pn++) {
    const data = await get(`service/playlist/${pid}/musicList`, { pn, rn: 100, source: SOURCE_OWN });
    const list = data.list || [];
    for (const t of list) ids.push(String(t.id));
    if (list.length < 100) break;
  }
  likedCache = { uid, ids, at: Date.now() };
  return ids;
}

export async function liked({ offset = 0 }) {
  const s = await requireSession();
  const pid = await likedPlaylistID(s.uid);
  if (!pid) return { tracks: [], more: false };
  const page = await get(`service/playlist/${pid}/musicList`, {
    pn: Math.floor(offset / PAGE) + 1,
    rn: PAGE,
    source: SOURCE_OWN,
  });
  const list = page.list || [];
  return { tracks: list.map(toTrack), more: list.length >= PAGE };
}

export async function isLiked({ ids }) {
  const s = session();
  if (!s) return Object.fromEntries((ids || []).map((id) => [String(id), false]));
  const liked = new Set(await likedIDs(s.uid));
  return Object.fromEntries((ids || []).map((id) => [String(id), liked.has(String(id))]));
}

export async function like({ id, on }) {
  const s = await requireSession();
  const pid = await likedPlaylistID(s.uid);
  if (!pid) throw new Error("波点音乐账号还没有「我喜欢」歌单");
  await post(on ? "service/playlist/music" : "service/playlist/music/delete", {
    playListId: Number(pid),
    musicIdList: [Number(digits(id))],
  });
  likedCache = null;
}

// --- albums and artists ----------------------------------------------------

export async function album({ id }) {
  const raw = parsePrefixed(id, "al");
  const data = await get(`service/album/${raw}`);
  const info = data.albumInfo || {};
  if (!info.id && !info.name) throw fail("unavailable", "专辑不可用");
  const songs = await get(`service/album/music/${raw}`, { pn: 1, rn: 1000 });
  return {
    album: toAlbum({ ...info, albumId: info.albumId || info.id }),
    tracks: (songs.resultList || []).map(toTrack),
  };
}

export async function artist({ id }) {
  const raw = parsePrefixed(id, "ar");
  const data = await get(`service/artist/${raw}`);
  const info = data.artistInfo || {};
  if (!info.id && !info.name) throw fail("unavailable", "歌手不可用");
  const [songs, albums, state] = await Promise.all([
    get(`service/artist/music/${raw}`, { pn: 1, rn: 50 }).catch(() => ({ resultList: [] })),
    get(`service/artist/album/${raw}`, { pn: 1, rn: 30 }).catch(() => ({ resultList: [] })),
    get("service/collect/multipleState", { source: SOURCE_ARTIST, sourceIds: raw }).catch(() => ({ result: [] })),
  ]);
  const followed = (state.result || []).some((r) => String(r.id) === raw && !!r.collect);
  return {
    artist: { ...toArtist(info), following: followed },
    tracks: (songs.resultList || []).map(toTrack),
    albums: (albums.resultList || []).map(toAlbum),
  };
}

// --- comments and lyrics ---------------------------------------------------

const COMMENT_HEADERS = { plat: "android" };
const COMMENT_PAGE = 30;

export async function comments({ trackId, offset = 0 }) {
  const raw = digits(trackId);
  if (Number(raw) > 2147483647) return { comments: [], total: 0, more: false };
  const data = await get("comments/v3/hot", {
    moduleType: 2,
    moduleId: raw,
    pn: Math.floor(offset / COMMENT_PAGE) + 1,
    rn: COMMENT_PAGE,
  }, { headers: COMMENT_HEADERS });
  return {
    comments: (data.comment_list || []).map(toComment),
    total: Number(data.comment_total) || 0,
    more: !!data.more,
  };
}

export async function likeComment({ trackId, commentId, on }) {
  const s = await requireSession();
  const raw = digits(trackId);
  await post("comments/v3/like", {
    uid: Number(s.uid),
    moduleType: 2,
    moduleId: Number(raw),
    commentId: Number(commentId),
    op: on ? 1 : 2,
  }, { headers: COMMENT_HEADERS });
}

export async function lyrics({ id }) {
  const raw = digits(id);
  const plain = `type=lyric&req=2&lrcx=0&rid=${raw}&songname=&artist=&corp=kuwo&fromchannel=bodian`;
  const url = `${LYRIC}?f=bodian&q=${encodeURIComponent(b64encode(plain))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA } });
    const body = await response.json();
    // The lyric service wraps what it says in data, unlike the API.
    const payload = (body && body.data) || body || {};
    if (!payload.content) return { lrc: "" };
    return { lrc: b64decode(payload.content) };
  } catch (error) {
    return { lrc: "" };
  } finally {
    clearTimeout(timer);
  }
}

// --- audio -----------------------------------------------------------------

// Bodian's bit rates: 20000 is its hires tier, which gives a FLAC where the
// song has one and a 320 kbps MP3 where it doesn't; 2000 is the FLAC itself;
// 320, 192 and 128 come back as 128 kbps MP3s.
const BITRATES = {
  standard: [128],
  high: [20000, 320, 128],
  lossless: [2000, 20000, 128],
};

function parseSize(text) {
  const m = /^\s*([\d.]+)\s*([kmg]?)b/i.exec(String(text || ""));
  if (!m) return 0;
  const unit = { "": 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2].toLowerCase()] || 1;
  return Math.round(Number(m[1]) * unit);
}

async function audioFor(raw, br) {
  const data = await get("play/music/v2/audioUrl", { devId: devid(), musicId: raw, br, freeSign: "" });
  if (!data || !data.audioUrl) return null;
  const type = String(data.format || "").toLowerCase();
  if (type !== "mp3" && type !== "flac") return null;
  return {
    url: data.audioHttpsUrl || data.audioUrl,
    type,
    bitRate: Number(data.bitrate) || br,
    size: parseSize(data.size),
    level: type === "flac" ? "lossless" : Number(data.bitrate) >= 320 ? "high" : "standard",
  };
}

const LEVELS = { standard: 1, high: 2, lossless: 3 };

export async function stream({ id, quality = "high" }) {
  const raw = digits(id);
  const asked = BITRATES[quality] ? quality : "high";
  let best = null;
  for (const br of BITRATES[asked]) {
    let found;
    try {
      found = await audioFor(raw, br);
    } catch (error) {
      if (error && error.code === "unavailable") continue;
      throw error;
    }
    if (!found) continue;
    if (!best || LEVELS[found.level] > LEVELS[best.level] || (LEVELS[found.level] === LEVELS[best.level] && found.bitRate > best.bitRate)) {
      best = found;
    }
    if (LEVELS[found.level] >= LEVELS[asked]) break;
  }
  if (!best) throw fail("unavailable", "波点音乐没有这首歌曲的播放权限");
  return {
    url: best.url,
    type: best.type,
    size: best.size,
    bitRate: best.bitRate,
    quality: best.level,
    headers: { "User-Agent": UA },
  };
}
