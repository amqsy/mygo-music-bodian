// 波点音乐 (Bodian) for MyGo Music.
//
// Bodian's API answers JSON under bd-api.kuwo.cn,
// with headers naming the app, and a session whose token is bound to this
// install's device ID. The plugin keeps both in host.storage.

const API = "https://bd-api.kuwo.cn/api/";
const LYRIC = "https://mlyric.kuwo.cn/mobi.s";
const UA = "Dart/3.3 (dart:io)";
const PAGE = 30;
const PLAYLIST_LIMIT = 1000;
const REQUEST_TIMEOUT = 8000;
// The host gives a call 30 seconds; stop short of it so the answer is ours.
const CALL_BUDGET = 25000;
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

// deadline is when a whole export has to answer, before the host's own 30s.
function deadline() {
  return Date.now() + CALL_BUDGET;
}

function expired(until) {
  return !!until && Date.now() >= until;
}

function timedOut() {
  return new Error(t("Bodian Music timed out, please try again"));
}

// safeURL keeps a remote address from naming anything but the web: the app
// would read a file:// URL it was given as a cover or a stream.
function safeURL(value) {
  const url = String(value || "");
  return /^https?:\/\//i.test(url) ? url : "";
}

// t is what the app says in the listener's language: the plugin writes
// English, and locales/zh-CN.json says it in Chinese.
function t(text, values) {
  let out = typeof host.t === "function" ? host.t(text) : text;
  if (values) {
    out = out.replace(/\{(\w+)\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole);
  }
  return out;
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
  if (!s) throw fail("signIn", t("Sign in to Bodian Music first"));
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

async function request(path, { query, method = "GET", body, headers: extra, deadline: until } = {}) {
  if (expired(until)) throw timedOut();
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
  const wait = until ? Math.min(REQUEST_TIMEOUT, until - Date.now()) : REQUEST_TIMEOUT;
  const timer = setTimeout(() => controller.abort(), Math.max(1, wait));
  init.signal = controller.signal;
  let envelope;
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      // The API answers its own errors in JSON with a 200, so a status here
      // is the web's, not Bodian's. Keep whichever code says more.
      let code = response.status;
      try {
        const answer = await response.json();
        if (answer && answer.code !== undefined && Number(answer.code) !== 200) code = answer.code;
      } catch (ignored) {
        // Not JSON: the status is all there is.
      }
      throw fail("http", t("Bodian Music answered with an error ({code})", { code }));
    }
    try {
      envelope = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw fail("invalid", t("Bodian Music returned invalid data"));
    }
  } catch (error) {
    if (controller.signal.aborted) throw timedOut();
    if (error && (error.code === "http" || error.code === "invalid")) throw error;
    throw new Error(t("Can’t reach Bodian Music, check your network"));
  } finally {
    clearTimeout(timer);
  }
  if (!envelope || typeof envelope !== "object") throw new Error(t("Bodian Music returned invalid data"));
  const code = Number(envelope.code);
  if (code !== 200) {
    if (SIGNED_OUT.includes(code)) {
      // Only the session the request went out with may be cleared: one
      // answered late can't wipe a session a sign-in has just stored.
      const current = session();
      if (!current || (s && current.uid === s.uid && current.token === s.token)) {
        setSession(null);
        forgetLibrary();
      }
      throw fail("signIn", t("Your Bodian Music session expired, sign in again"));
    }
    if (NO_STREAM.includes(code)) throw fail("unavailable", t("Bodian Music can’t play this song"));
    // "api" says the answer came, and says no: a probe for a playlist in
    // another of Bodian's lists can go on, a network failure can't.
    throw fail("api", t("Bodian Music answered with an error ({code})", { code: Number.isFinite(code) ? code : "?" }));
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
// A calendar card is a story, not only its song: the same song can come back
// on another day under another story, so the entry's id leads.
const calendarID = (entry, song) => `cal-${entry}-${song}`;

function digits(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || Number(text) <= 0) throw fail("unavailable", t("Invalid Bodian Music ID"));
  return text;
}

function parsePrefixed(value, prefix) {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(value ?? ""));
  if (!m) throw fail("unavailable", t("Invalid Bodian Music ID"));
  return m[1];
}

function parsePlaylistID(value) {
  const m = /^pl-(\d+)-(\d+)$/.exec(String(value ?? ""));
  if (!m) throw fail("unavailable", t("Invalid Bodian Music playlist"));
  return { source: Number(m[1]), raw: m[2] };
}

// --- mapping ---------------------------------------------------------------

function artistOf(id, name, image) {
  return { id: artistID(id), name: name || "", imageUrl: safeURL(image) };
}

function toArtist(wire = {}) {
  return artistOf(wire.id || wire.artistId, wire.name, wire.pic);
}

function toAlbum(wire = {}) {
  // A track wire carries its song's id; only an album wire's own id names an
  // album, so a track without an albumId gets none rather than the song's.
  const id = wire.albumId || (wire.album || wire.albumPic ? "" : wire.id) || "";
  const artists = Array.isArray(wire.artists) && wire.artists.length
    ? wire.artists.map(toArtist)
    : wire.artist
      ? [artistOf(wire.artistId, wire.artist)]
      : [];
  return {
    id: id ? albumID(id) : "",
    name: wire.album || wire.name || "",
    imageUrl: safeURL(wire.albumPic || wire.pic),
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
    imageUrl: safeURL(wire.pic || wire.cover),
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
    imageUrl: safeURL(wire.pic),
    description: wire.pub ? t("Updated {date}", { date: wire.pub }) : "",
    trackCount: Number(wire.total) || (Array.isArray(wire.musics) ? wire.musics.length : 0),
  };
}

function toComment(wire = {}) {
  const user = wire.userInfo || {};
  return {
    id: String(wire.id ?? ""),
    author: user.nickname || wire.nickname || "",
    avatarUrl: safeURL(user.headImg || wire.headImg),
    text: wire.content || "",
    time: commentTime(wire.publishTime || wire.createTime),
    likes: Number(wire.likeCount) || 0,
    liked: Number(wire.like) !== 0,
  };
}

// Bodian says a comment's time as the app in China does, sometimes with only
// its day; both are read as Beijing time rather than the listener's.
function commentTime(text) {
  const value = String(text || "").trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!match) {
    match = /^(\d{2})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
    if (!match) return 0;
    match = [match[0], `20${match[1]}`, match[2], match[3], match[4], match[5], match[6]];
  }
  const at = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    (Number(match[4]) || 0) - 8, Number(match[5]) || 0, Number(match[6]) || 0,
  );
  return Number.isFinite(at) ? at : 0;
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

async function profileOf(uid, until) {
  const data = await get(`ucenter/users/pub/${uid}`, { fromUid: uid, platform: "ios" }, { deadline: until });
  const user = (data && data.userInfo) || data || {};
  return {
    id: String(user.id || uid),
    name: user.nickname || user.name || t("Bodian Music listener"),
    imageUrl: safeURL(user.headImg || user.avatar),
    page: "me",
  };
}

export async function signIn() {
  host.signInPrompt({ text: t("Getting the sign-in QR code…") });
  const { qrCode } = await get("ucenter/login/qrCode");
  if (!qrCode) throw new Error(t("Bodian Music did not return a sign-in QR code"));
  const content = `https://bodian-oia.kuwo.cn/bodian/download.html?pageName=login_pc&pt=3&id=${encodeURIComponent(qrCode)}`;
  host.signInPrompt({ qr: content, text: t("Scan with the Bodian Music app and confirm on your phone") });

  // Leave the host's five minutes room for the login and the profile.
  const ends = Date.now() + 240000;
  const pollUntil = Math.min(Date.now() + 150000, ends - 60000);
  let confirmed = false;
  while (Date.now() < pollUntil) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let status;
    try {
      ({ status } = await get("ucenter/login/qrCodeStatus", { qrCode }));
    } catch (error) {
      continue;
    }
    if (Number(status) === 2) throw new Error(t("The QR code expired, sign in again"));
    if (Number(status) === 3) {
      confirmed = true;
      break;
    }
  }
  if (!confirmed) throw new Error(t("Sign-in was cancelled or timed out"));

  // The phone confirmed it; the session may take a moment to be issued. The
  // login is retried only until a session comes back: the QR code is spent
  // once it does, and the profile is asked for separately.
  let data = null;
  for (let attempt = 0; attempt < 5 && !data; attempt++) {
    if (Date.now() > ends - 20000) break;
    try {
      const answer = await post("ucenter/users/login", { authType: 10, qrCode });
      const id = answer && (answer.id || (answer.userInfo && answer.userInfo.id));
      if (!answer || !answer.token || !id) throw new Error(t("Bodian Music did not return a session"));
      data = answer;
    } catch (error) {
      if (error && error.code === "unavailable") throw error;
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const uid = data && (data.id || (data.userInfo && data.userInfo.id));
  if (!data || !data.token || !uid) throw new Error(t("Sign-in failed, scan again"));
  setSession({ uid: String(uid), token: data.token });
  forgetLibrary();

  let profile = null;
  try {
    profile = await profileOf(uid);
  } catch (error) {
    if (error && error.code === "signIn") throw error;
    // The session is good; a profile that didn't load leaves the name out.
  }
  if (!profile) profile = { id: String(uid), name: t("Bodian Music listener"), imageUrl: "", page: "me" };
  if (data.userInfo) {
    profile.name = data.userInfo.nickname || profile.name;
    profile.imageUrl = safeURL(data.userInfo.headImg) || profile.imageUrl;
  }
  host.signInPrompt({ text: t("Signed in") });
  return profile;
}

export function signOut() {
  setSession(null);
  forgetLibrary();
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
  throw fail("unsupported", t("Bodian Music can’t search for that"));
}

export async function suggest({ query }) {
  const text = String(query || "").trim();
  // What listeners type is answered with what they are about to type; an
  // empty box gets Bodian's hot words instead.
  try {
    if (text) {
      const data = await get("search/tip/v2/list", { keyword: text });
      return (data.resultList || []).map((w) => w.relword).filter(Boolean).slice(0, 10);
    }
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
    for (const bang of group.bangList || []) {
      // The H5 charts Bodian lists have no id, and open nothing.
      if (!bang || !bang.id) continue;
      out.push(toChart(bang));
    }
  }
  return out;
}

async function featuredPlaylists(limit = 30) {
  const data = await module(2);
  const list = (data.songList || []).map(toPlaylist);
  return limit > 0 ? list.slice(0, limit) : list;
}

// --- radio -----------------------------------------------------------------

// The scenes the radio hub offers. Its own list is the truth; these are the
// ones it always had, for when it answers with nothing (signed out, or away).
function sceneFallback() {
  return [
    { id: 110, name: t("Driving") },
    { id: 111, name: t("Workout") },
    { id: 112, name: t("Study") },
    { id: 114, name: t("Sleep") },
  ];
}

async function scenes() {
  try {
    const data = await get("service/radio/scene_radio");
    const list = (data.result || []).filter((scene) => scene && scene.id);
    if (list.length) return list;
  } catch (error) {
    // Signed out, or the hub is away: carry on with the scenes it always had.
  }
  return sceneFallback();
}

// A station is endless here, so each one remembers how far it has read and
// what it has already played.
const stationAt = new Map();
const stationPlayed = new Map();

export async function stations() {
  const out = [
    {
      id: "guess",
      name: t("Guess You Like"),
      description: t("Bodian Music picks, one after another"),
    },
  ];
  for (const scene of await scenes()) {
    out.push({
      id: `scene-${scene.id}`,
      name: scene.name || "",
      description: t("Scene radio · {name}", { name: scene.name || "" }),
      imageUrl: safeURL(scene.pic),
    });
  }
  return out;
}

export async function stationNext({ id }) {
  const key = String(id || "");
  const scene = /^scene-(\d+)$/.exec(key);
  if (key !== "guess" && !scene) throw fail("unavailable", t("Invalid Bodian Music station"));

  const until = deadline();
  const seen = stationPlayed.get(key) || new Set();
  const page = stationAt.get(key) || 0;
  // A page may hold songs the station already played; the listener asked for
  // more, so read on until there is something new.
  for (let tries = 1; tries <= 3; tries += 1) {
    if (expired(until)) throw timedOut();
    const next = page + tries;
    const data = key === "guess"
      ? await get("service/music/recommendList", { pn: next, rn: 30, select_card: 1 }, { deadline: until })
      : await get(`service/category/${scene[1]}/musics`, { pn: next, rn: PAGE }, { deadline: until });
    const tracks = (data.musicList || []).map(toTrack).filter((track) => track.id && !seen.has(track.id));
    if (tracks.length) {
      stationAt.set(key, next);
      for (const track of tracks) seen.add(track.id);
      stationPlayed.set(key, seen);
      return tracks;
    }
  }
  stationAt.set(key, page + 3);
  stationPlayed.set(key, seen);
  return [];
}

// guessTracks is 猜你想听: a recommendation stream that answers a few songs at
// a time, so a handful of pages make a section.
async function guessTracks(count = 20) {
  const batches = await Promise.all([1, 2, 3].map((pn) =>
    get("service/music/recommendList", { pn, rn: 30, select_card: 1 })
      .then((data) => data.musicList || [])
      .catch(() => [])));
  const out = [];
  const seen = new Set();
  for (const wire of batches.flat()) {
    const track = toTrack(wire);
    if (!track.id || seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
    if (out.length >= count) break;
  }
  return out;
}

// settle answers what a section fetched, or what it shows without it.
function settle(promise, fallback) {
  return promise.then((value) => ({ value }), (error) => ({ error, fallback }));
}

async function homeSections() {
  const sections = [];
  const parts = await Promise.all([
    settle(dailySongs(), []),
    settle(guessTracks(10), []),
    settle(module(4), null),
    settle(module(11), null),
    settle(themedSections(), []),
    session() ? settle(module(10), null) : { value: null },
    settle(featuredPlaylists(24), []),
    settle(charts(), []),
  ]);
  // A section that failed leaves the rest standing, but a session that ran
  // out is the listener's to answer, not the page's to swallow.
  const failed = parts.filter((part) => part.error);
  const signedOut = failed.find((part) => part.error && part.error.code === "signIn");
  if (signedOut) throw signedOut.error;
  const [daily, guess, lab, video, themes, similar, featured, chartList] =
    parts.map((part) => (part.error ? part.fallback : part.value));

  if (daily.length) {
    sections.push({
      title: t("Daily Picks"),
      pageTitle: t("Daily Picks"),
      subtitle: t("Picked for you every day by Bodian Music"),
      tracks: daily,
      morePage: "daily",
    });
  }
  if (guess.length) {
    sections.push({
      title: t("Guess You Like"),
      subtitle: t("Bodian Music picks, one after another"),
      tracks: guess,
    });
  }
  const labMusic = lab && lab.lab && lab.lab.music;
  if (labMusic && labMusic.id) {
    // The lab's own name, not the calendar story: its song is the lab's pick,
    // while the story has its own page and song.
    sections.push({ title: t("Bodian Lab"), tracks: [toTrack(labMusic)] });
  }
  if (video && Array.isArray(video.video) && video.video.length) {
    sections.push({ title: t("Something Different"), tracks: video.video.map(toTrack) });
  }
  sections.push(...themes);
  const similarTracks = similar && Array.isArray(similar.musicList) ? similar.musicList.map(toTrack) : [];
  if (similarTracks.length) {
    sections.push({
      title: similar.moduleName || t("More Like What You Liked"),
      tracks: similarTracks,
    });
  }
  if (featured.length) {
    sections.push({ title: t("Recommended Playlists"), playlists: featured, morePage: "square" });
  }
  if (chartList.length) {
    sections.push({ title: t("Charts"), playlists: chartList.slice(0, 8), morePage: "charts" });
  }
  // Every section failed: let the app show its error and offer a retry,
  // rather than an empty Home that looks like an account with nothing in it.
  if (!sections.length && failed.length) throw failed[0].error;
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
  return {
    title: t("Discover"),
    subtitle: session() ? t("Bodian Music") : t("Bodian Music · sign in to see your playlists"),
    sections: await homeSections(),
  };
}

const SQUARE_PAGE = 60;
const TOPIC_PAGE = 60;
const CALENDAR_PAGE = 30;

// Bodian's category tree: six groups, each with the leaf ids its playlists
// are filed under. Only the leaves filter; a group's own id answers nothing.
let categoryTree = null;

async function categoryTreeOf() {
  if (!categoryTree) categoryTree = await get("service/category/list");
  return categoryTree;
}

async function categoryPage(id, page) {
  const pn = Math.max(1, Number(page) || 1);
  const data = await get(`service/category/${digits(id)}/playlist`, { pn, rn: SQUARE_PAGE });
  return { playlists: (data.playLists || []).map(toPlaylist), total: Number(data.total) || 0, pn };
}

async function categoryName(id) {
  try {
    const tree = await categoryTreeOf();
    for (const group of tree.categories || []) {
      for (const sub of group.subCategories || []) {
        if (String(sub.id) === String(id)) return sub.name || "";
      }
    }
  } catch (error) {
    // A category page can still open without its name.
  }
  return "";
}

// 话题: each topic has its own playlist, so a topic card opens like one.
const topicID = (raw) => `tp-${raw}`;

function toTopic(wire = {}) {
  return {
    id: topicID(wire.id),
    name: wire.name || "",
    imageUrl: safeURL(wire.pic),
    description: wire.description || "",
    trackCount: Number(wire.musicCnt) || 0,
  };
}

async function topicPage(page) {
  const pn = Math.max(1, Number(page) || 1);
  const data = await get("service/music_topics/list", { pn, rn: TOPIC_PAGE });
  return { playlists: (data.lists || []).map(toTopic), total: Number(data.total) || 0, pn };
}

// 音乐日历: a song of the day with the story Bodian tells about it. The card
// shows the story; its source id is the song's.
const CALENDAR_STORIES = "calendarStories";
// The host keeps a page of cards after the plugin has stopped holding it, so
// the stories read are kept for the next run too. The calendar grows a day at
// a time; this holds years of it, and storage grows by a few bytes a day.
const CALENDAR_STORY_LIMIT = 2000;
let calendarStories = null;
let storiesDirty = false;

function calendarStoriesOf() {
  if (!calendarStories) {
    const saved = host.storage.get(CALENDAR_STORIES);
    calendarStories = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }
  return calendarStories;
}

function rememberStory(id, story) {
  const all = calendarStoriesOf();
  const old = all[id];
  if (old && old.name === story.name && old.imageUrl === story.imageUrl && old.description === story.description) return;
  all[id] = story;
  storiesDirty = true;
}

function saveStories() {
  if (!storiesDirty) return;
  const all = calendarStoriesOf();
  const keys = Object.keys(all);
  // Oldest first, as they were read.
  for (const key of keys.slice(0, Math.max(0, keys.length - CALENDAR_STORY_LIMIT))) delete all[key];
  host.storage.set(CALENDAR_STORIES, all);
  storiesDirty = false;
}

function toCalendarEntry(wire = {}) {
  const entry = String(wire.id || "");
  const song = String(wire.source || "");
  // Bodian files the calendar's song under sourceType 2; another kind of
  // entry would need an endpoint this page does not have.
  if (!entry || !song || Number(wire.sourceType) !== 2) return null;
  const story = {
    name: wire.title || "",
    imageUrl: safeURL(wire.pic),
    description: [wire.tag, wire.showDate].filter(Boolean).join(" · "),
  };
  const id = calendarID(entry, song);
  rememberStory(id, story);
  // song is for the page to ask about; it is not part of the card it hands
  // the app.
  return { id, ...story, song };
}

const calendarTracks = new Map();

function rememberTrack(raw, track) {
  calendarTracks.set(String(raw), track);
  // The calendar is read page by page; one session's worth is plenty.
  if (calendarTracks.size > 600) calendarTracks.delete(calendarTracks.keys().next().value);
}

async function calendarSong(raw, until) {
  const key = String(raw);
  const cached = calendarTracks.get(key);
  if (cached) return cached;
  // A song Bodian has taken down answers no info, or says so outright.
  const info = await get("service/music/info", { musicId: raw }, { deadline: until });
  if (!info || !info.id) throw fail("unavailable", t("Bodian Music can’t play this song"));
  const track = toTrack(info);
  rememberTrack(key, track);
  return track;
}

// What a calendar card says under its story: the song and who sings it.
function calendarLine(track) {
  const artist = (track.artists || []).map((a) => a.name).filter(Boolean).join(", ");
  return artist ? `${track.name} · ${artist}` : track.name || "";
}

// What listeners of the story's song hear next. The story page is a small
// playlist around it rather than a page that holds a single song.
async function calendarRelated(song, until) {
  const seen = new Set([String(song)]);
  const out = [];
  // Every answer is a taste of what goes with the song; the lists overlap,
  // so a few pages of them make a fuller set than one.
  const wants = [];
  for (const type of [0, 1, 2]) for (const pn of [1, 2]) wants.push({ type, pn });
  const lists = await Promise.all(wants.map(({ type, pn }) =>
    get("rec/music/similar/list", { musicId: song, pn, rn: 20, type }, { deadline: until })
      .catch(() => ({ musicList: [] }))));
  for (const data of lists) {
    for (const wire of data.musicList || []) {
      const track = toTrack(wire);
      if (!track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      out.push(track);
    }
    if (out.length >= 18) break;
  }
  return out.slice(0, 18);
}

async function calendarPage(page) {
  const pn = Math.max(1, Number(page) || 1);
  const until = deadline();
  const data = await get("service/musicCalendar/list/history", { pn, rn: CALENDAR_PAGE }, { deadline: until });
  const list = Array.isArray(data.list) ? data.list : [];
  // A day without a song has nothing to open.
  const entries = list.map(toCalendarEntry).filter(Boolean);
  saveStories();
  // The story alone says little, so the card also names the song it is about.
  const playlists = await Promise.all(entries.map(async ({ song, ...card }) => {
    try {
      return { ...card, owner: calendarLine(await calendarSong(song, until)) };
    } catch (error) {
      // The card still opens, to say the song can't be played.
      return card;
    }
  }));
  return { playlists, pn, more: list.length >= CALENDAR_PAGE };
}

async function squarePage(page) {
  const pn = Math.max(1, Number(page) || 1);
  const data = await get("service/category/playlist", { pn, rn: SQUARE_PAGE });
  return { playlists: (data.playLists || []).map(toPlaylist), total: Number(data.total) || 0, pn };
}

export async function browse({ page }) {
  if (page === "daily") {
    return { title: t("Daily Picks"), subtitle: t("Picked for you every day by Bodian Music"), sections: [{ tracks: await dailySongs() }] };
  }
  if (page === "charts") {
    return { title: t("Charts"), sections: [{ playlists: await charts() }] };
  }
  if (page === "square" || /^square-\d+$/.test(String(page))) {
    const wanted = page === "square" ? 1 : Number(String(page).slice("square-".length));
    const { playlists, total, pn } = await squarePage(wanted);
    // The page already says its title; a section titled the same reads twice.
    // The way into the categories sits above the grid, where it's seen without
    // scrolling through it.
    const sections = [
      { links: [{ title: t("Browse by category"), subtitle: t("Pick a category to browse its playlists"), page: "cat" }] },
      { playlists },
    ];
    const shown = (pn - 1) * SQUARE_PAGE + playlists.length;
    const links = [];
    if (shown < total) links.push({ title: t("Next Page"), subtitle: t("Shown {shown} of {total}", { shown, total }), page: `square-${pn + 1}` });
    if (pn > 1) links.push({ title: t("Previous Page"), page: `square-${pn - 1}` });
    if (links.length) sections.push({ title: t("More"), links });
    return { title: t("Playlist Square"), subtitle: t("Playlists Bodian Music listeners shared"), sections };
  }
  if (page === "cat") {
    const tree = await categoryTreeOf();
    const sections = (tree.categories || [])
      .filter((group) => Array.isArray(group.subCategories) && group.subCategories.length)
      .map((group) => ({
        title: group.name || "",
        links: group.subCategories.map((sub) => ({ title: sub.name || "", page: `cat-${sub.id}` })),
      }));
    return { title: t("Categories"), subtitle: t("Pick a category to browse its playlists"), sections };
  }
  const cat = /^cat-(\d+)(?:-(\d+))?$/.exec(String(page));
  if (cat) {
    const id = cat[1];
    const wanted = cat[2] ? Number(cat[2]) : 1;
    const [{ playlists, total, pn }, name] = await Promise.all([categoryPage(id, wanted), categoryName(id)]);
    const title = name || t("Categories");
    // Bodian's tree lists a few categories it has no playlists for; say so
    // rather than showing a page with nothing on it.
    const sections = [{ playlists, empty: t("No playlists in this category yet") }];
    const shown = (pn - 1) * SQUARE_PAGE + playlists.length;
    const links = [];
    if (shown < total) links.push({ title: t("Next Page"), subtitle: t("Shown {shown} of {total}", { shown, total }), page: `cat-${id}-${pn + 1}` });
    if (pn > 1) links.push({ title: t("Previous Page"), page: `cat-${id}-${pn - 1}` });
    if (links.length) sections.push({ title: t("More"), links });
    return { title, sections };
  }
  if (page === "topics" || /^topics-\d+$/.test(String(page))) {
    const wanted = page === "topics" ? 1 : Number(String(page).slice("topics-".length));
    const { playlists, total, pn } = await topicPage(wanted);
    const sections = [{ playlists }];
    const shown = (pn - 1) * TOPIC_PAGE + playlists.length;
    const links = [];
    if (shown < total) links.push({ title: t("Next Page"), subtitle: t("Shown {shown} of {total}", { shown, total }), page: `topics-${pn + 1}` });
    if (pn > 1) links.push({ title: t("Previous Page"), page: `topics-${pn - 1}` });
    if (links.length) sections.push({ title: t("More"), links });
    return { title: t("Topics"), subtitle: t("Bodian Music listeners’ topics"), sections };
  }
  if (page === "calendar" || /^calendar-\d+$/.test(String(page))) {
    const wanted = page === "calendar" ? 1 : Number(String(page).slice("calendar-".length));
    const { playlists, pn, more } = await calendarPage(wanted);
    const sections = [{ playlists, empty: pn > 1 ? "" : t("No calendar entries yet") }];
    const links = [];
    // The calendar answers no total, so a full page is what says there may be
    // another one behind it.
    if (more) links.push({ title: t("Next Page"), page: `calendar-${pn + 1}` });
    if (pn > 1) links.push({ title: t("Previous Page"), page: `calendar-${pn - 1}` });
    if (links.length) sections.push({ title: t("More"), links });
    return { title: t("Music Calendar"), subtitle: t("A song and a story for every day"), sections };
  }
  if (page === "me") {
    const s = await requireSession();
    const until = deadline();
    const [[mine, saved], profile] = await Promise.all([
      myPlaylists(s.uid, until),
      profileOf(s.uid, until).catch(() => null),
    ]);
    return {
      title: profile ? profile.name : t("My Bodian Music"),
      imageUrl: profile ? profile.imageUrl : "",
      sections: [
        { title: t("My Playlists"), playlists: mine, empty: t("No playlists yet") },
        { title: t("Saved Playlists"), playlists: saved, empty: t("No saved playlists yet") },
      ],
    };
  }
  throw fail("unsupported", t("There’s no such page"));
}

// --- library ---------------------------------------------------------------

// The ids of the listener's own playlists, and of those they saved, as the
// library lists them: the id a playlist is found by need not be the same.
const ownPlaylistIDs = new Set();
const savedPlaylistIDs = new Set();

async function myPlaylists(uid, until) {
  const data = await get("service/playlist/userCreate", { userId: uid }, { deadline: until });
  // This list has no sourceType, and its playlists are the listener's own.
  const mine = (data.playLists || [])
    .map((p) => toPlaylist({ ...p, sourceType: SOURCE_OWN }))
    .map((p) => ({ ...p, mine: true }));
  for (const p of mine) ownPlaylistIDs.add(p.id);
  const saved = [];
  const fresh = new Set();
  let complete = true;
  try {
    for (let pn = 1; pn <= 10; pn++) {
      if (expired(until)) {
        complete = false;
        break;
      }
      const collected = await get("service/collect/4/list", { userId: uid, pn, rn: 100 }, { deadline: until });
      const list = collected.playLists || [];
      for (const p of list) {
        if (Number(p.sourceType) === SOURCE_OTHERS) {
          saved.push({ ...toPlaylist(p), saved: true });
          fresh.add(plID(SOURCE_OTHERS, String(p.id)));
        }
      }
      if (list.length < 100) break;
    }
  } catch (error) {
    // Saved lists are the listener's own; a failure here leaves them out.
    complete = false;
  }
  // A walk that was cut short adds what it saw but doesn't forget the rest.
  if (complete) savedPlaylistIDs.clear();
  for (const id of fresh) savedPlaylistIDs.add(id);
  return [mine, saved];
}

export async function playlists() {
  const s = session();
  if (!s) return [];
  const [mine, saved] = await myPlaylists(s.uid, deadline());
  return [...mine, ...saved];
}

// order says which of Bodian's lists to try after the one the id names. A
// topic's playlist is one a listener made (5), while source 4 can hold a
// different playlist that happens to have the same id.
async function playlistSource(raw, source, until, order) {
  const path = `service/playlist/info/${raw}`;
  const tried = [];
  // Other sources answer hollow entries; try the listener's own list first.
  for (const st of [source, ...(order || [SOURCE_OWN, SOURCE_OTHERS, SOURCE_LIKED])]) {
    if (!st || tried.includes(st)) continue;
    tried.push(st);
    if (expired(until)) throw timedOut();
    let info;
    try {
      info = await get(path, { source: st }, { deadline: until });
    } catch (error) {
      // Only "not in this list" carries on to the next one; a network
      // failure or a timeout is the listener's answer, not a wrong source.
      if (error && error.code === "api") continue;
      throw error;
    }
    if (info && info.id && info.name) return { info, source: st };
  }
  throw fail("unavailable", t("This playlist is gone, or your account can’t see it"));
}

// A playlist is the listener's own when the library lists it, or when Bodian
// says they made it. The list it was found in is not enough: every search
// result is source 5 too.
function mineNow(info, raw) {
  if (ownPlaylistIDs.has(plID(SOURCE_OWN, raw))) return true;
  const s = session();
  if (!s) return false;
  const creator = Number(info && info.creatorId) || 0;
  return creator !== 0 && creator === Number(s.uid);
}

async function playlistTracks(raw, source, until) {
  const out = [];
  for (let pn = 1; pn <= 20; pn++) {
    if (expired(until)) break;
    let data;
    try {
      data = await get(`service/playlist/${raw}/musicList`, { pn, rn: PLAYLIST_LIMIT, source }, { deadline: until });
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
  const until = deadline();
  if (/^cal-\d+-\d+$/.test(String(id))) {
    const [, entry, song] = /^cal-(\d+)-(\d+)$/.exec(String(id));
    const track = await calendarSong(song, until);
    const related = await calendarRelated(song, until);
    const story = calendarStoriesOf()[calendarID(entry, song)];
    return {
      id: calendarID(entry, song),
      // The story is what the card promised; the song's name is what is left
      // when the card was not the way in.
      name: (story && story.name) || track.name || t("Music Calendar"),
      imageUrl: (story && story.imageUrl) || track.album.imageUrl || "",
      description: story ? story.description : "",
      trackCount: 1 + related.length,
      tracks: [track, ...related],
      // A calendar entry is a page, not a playlist the listener can collect.
      mine: true,
    };
  }
  if (/^tp-\d+$/.test(String(id))) {
    const raw = parsePrefixed(id, "tp");
    const topic = await get("service/music_topics/details", { topicId: raw }, { deadline: until });
    if (!topic || !topic.id) throw fail("unavailable", t("This topic is gone"));
    let pl = null;
    if (topic.playlistId) {
      try {
        // A topic's playlist is one a listener made (5), not one of the
        // square's (4), which may hold another playlist with the same id.
        const { info, source } = await playlistSource(
          String(topic.playlistId), 0, until, [SOURCE_OWN, SOURCE_LIKED, SOURCE_OTHERS]);
        const tracks = await playlistTracks(String(topic.playlistId), source, until);
        pl = { ...toPlaylist(info), tracks };
      } catch (error) {
        // The topic's playlist is gone or unreadable; the clips it lists
        // still name songs.
        pl = null;
      }
    }
    if (!pl) {
      const data = await get("service/music_topics/music_list", { topicId: raw, pn: 1, rn: 30 }, { deadline: until });
      const ids = [...new Set((data.lists || []).map((clip) => clip.musicId).filter(Boolean))];
      const infos = await Promise.all(ids.slice(0, 30).map((musicId) =>
        get("service/music/info", { musicId }, { deadline: until }).catch(() => null)));
      pl = {
        id: topicID(raw),
        name: topic.name || "",
        imageUrl: safeURL(topic.pic),
        description: topic.description || "",
        tracks: infos.filter(Boolean).map(toTrack),
      };
    }
    return {
      ...pl,
      id: topicID(raw),
      name: topic.name || pl.name || "",
      imageUrl: safeURL(topic.pic) || pl.imageUrl || "",
      description: topic.description || pl.description || "",
      trackCount: (pl.tracks || []).length,
      // The app offers Save on any playlist page whose Mine is unset; a
      // topic is not a playlist the listener can collect.
      mine: true,
    };
  }
  if (/^bang-\d+$/.test(String(id))) {
    const raw = parsePrefixed(id, "bang");
    const data = await get(`service/bang/${raw}/musics`, { pn: 1, rn: PLAYLIST_LIMIT }, { deadline: until });
    return {
      id: bangID(raw),
      name: data.name || t("Charts"),
      imageUrl: safeURL(data.pic),
      description: data.pub ? t("Updated {date}", { date: data.pub }) : "",
      trackCount: Number(data.total) || (data.musics || []).length,
      tracks: (data.musics || []).map(toTrack),
      // A chart is not a playlist the listener can collect, either.
      mine: true,
    };
  }
  const { source, raw } = parsePlaylistID(id);
  const { info, source: st } = await playlistSource(raw, source, until);
  const pl = toPlaylist(info);
  pl.mine = mineNow(info, raw);
  // A playlist of the listener's own keeps the id the library lists it under,
  // whichever of Bodian's lists it was found in.
  pl.id = plID(pl.mine ? SOURCE_OWN : st, raw);
  // The id a playlist was found by (5, say) needn't be the one the library
  // lists it under (4), so the raw id says whether it is saved.
  pl.saved = savedPlaylistIDs.has(plID(SOURCE_OTHERS, raw)) || (st === SOURCE_OTHERS && !!info.collect);
  pl.tracks = await playlistTracks(raw, st, until);
  if (!pl.trackCount) pl.trackCount = pl.tracks.length;
  return pl;
}

export async function createPlaylist({ name }) {
  const title = String(name || "").trim();
  if (!title) throw new Error(t("A playlist needs a name"));
  await requireSession();
  const data = await post("service/playlist", { name: title, private: false });
  const raw = data && (data.id || data.playlistId);
  if (!raw) throw new Error(t("Bodian Music did not return the new playlist’s ID"));
  const id = plID(SOURCE_OWN, raw);
  ownPlaylistIDs.add(id);
  return { id, name: title, mine: true, trackCount: 0, tracks: [] };
}

export async function renamePlaylist({ id, name }) {
  const title = String(name || "").trim();
  if (!title) throw new Error(t("A playlist needs a name"));
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
  ownPlaylistIDs.delete(plID(SOURCE_OWN, raw));
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
  const key = String(id || "");
  // A chart or a topic is a page, not a playlist to collect; say so rather
  // than failing on its id.
  if (/^(bang|tp)-/.test(key)) throw fail("unsupported", t("Bodian Music can’t save that"));
  const { raw } = parsePlaylistID(key);
  await collect(SOURCE_OTHERS, raw, on);
  const saved = plID(SOURCE_OTHERS, raw);
  if (on) savedPlaylistIDs.add(saved);
  else savedPlaylistIDs.delete(saved);
}

export async function saveAlbum({ id, on }) {
  await collect(SOURCE_ALBUM, parsePrefixed(id, "al"), on);
}

export async function followArtist({ id, on }) {
  await collect(SOURCE_ARTIST, parsePrefixed(id, "ar"), on);
}

async function likedPlaylistID(uid, until) {
  const data = await get("service/playlist/fond", { userId: uid }, { deadline: until });
  return String(data && data.id ? data.id : "");
}

let likedCache = null;
let likedLoading = null;
let likedGeneration = 0;

// A session that starts or ends forgets what the last one's library was.
function forgetLibrary() {
  ownPlaylistIDs.clear();
  savedPlaylistIDs.clear();
  likedCache = null;
  likedLoading = null;
  likedGeneration += 1;
}

async function loadLikedIDs(uid) {
  const generation = likedGeneration;
  const until = deadline();
  const pid = await likedPlaylistID(uid, until);
  if (!pid) return [];
  const ids = [];
  for (let pn = 1; pn <= 100; pn++) {
    if (expired(until)) throw timedOut();
    const data = await get(`service/playlist/${pid}/musicList`, { pn, rn: 100, source: SOURCE_OWN }, { deadline: until });
    const list = data.list || [];
    for (const t of list) ids.push(String(t.id));
    if (list.length < 100) break;
  }
  // A like during the walk changed the set it was reading: leave the cache
  // empty so the next ask reads it again rather than the stale snapshot.
  if (generation === likedGeneration) likedCache = { uid, ids, at: Date.now() };
  return ids;
}

// likedIDs answers the whole liked set; callers asking at the same time wait
// on one walk of it rather than each starting their own.
async function likedIDs(uid) {
  if (likedCache && likedCache.uid === uid && Date.now() - likedCache.at < 60000) return likedCache.ids;
  if (likedLoading && likedLoading.uid === uid) return likedLoading.promise;
  const promise = loadLikedIDs(uid);
  likedLoading = { uid, promise };
  try {
    return await promise;
  } finally {
    if (likedLoading && likedLoading.promise === promise) likedLoading = null;
  }
}

export async function liked({ offset = 0 }) {
  const s = await requireSession();
  const until = deadline();
  const pid = await likedPlaylistID(s.uid, until);
  if (!pid) return { tracks: [], more: false };
  const page = await get(`service/playlist/${pid}/musicList`, {
    pn: Math.floor(offset / PAGE) + 1,
    rn: PAGE,
    source: SOURCE_OWN,
  }, { deadline: until });
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
  const until = deadline();
  const raw = digits(id);
  const pid = await likedPlaylistID(s.uid, until);
  if (!pid) throw new Error(t("This account has no Liked Songs playlist yet"));
  await post(on ? "service/playlist/music" : "service/playlist/music/delete", {
    playListId: Number(pid),
    musicIdList: [Number(raw)],
  }, { deadline: until });
  // Keep the set the hearts read from in step, rather than dropping it and
  // walking the whole playlist again. A walk already in flight is left to
  // answer its callers but won't store its pre-like snapshot.
  likedGeneration += 1;
  if (likedCache && likedCache.uid === String(s.uid)) {
    const ids = new Set(likedCache.ids);
    if (on) ids.add(raw);
    else ids.delete(raw);
    likedCache = { uid: likedCache.uid, ids: [...ids], at: Date.now() };
  }
}

// --- albums and artists ----------------------------------------------------

export async function album({ id }) {
  const raw = parsePrefixed(id, "al");
  const until = deadline();
  const data = await get(`service/album/${raw}`, undefined, { deadline: until });
  const info = data.albumInfo || {};
  if (!info.id && !info.name) throw fail("unavailable", t("This album isn’t available"));
  const [songs, state] = await Promise.all([
    get(`service/album/music/${raw}`, { pn: 1, rn: 1000 }, { deadline: until }),
    get("service/collect/multipleState", { source: SOURCE_ALBUM, sourceIds: raw }, { deadline: until })
      .catch(() => ({ result: [] })),
  ]);
  const saved = (state.result || []).some((row) => String(row.id) === raw && !!row.collect);
  return {
    album: { ...toAlbum({ ...info, albumId: info.albumId || info.id }), saved },
    tracks: (songs.resultList || []).map(toTrack),
  };
}

export async function artist({ id }) {
  const raw = parsePrefixed(id, "ar");
  const data = await get(`service/artist/${raw}`);
  const info = data.artistInfo || {};
  if (!info.id && !info.name) throw fail("unavailable", t("This artist isn’t available"));
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

async function audioFor(raw, br, until) {
  const data = await get("play/music/v2/audioUrl", { devId: devid(), musicId: raw, br, freeSign: "" }, { deadline: until });
  if (!data || !data.audioUrl) return null;
  const type = String(data.format || "").toLowerCase();
  if (type !== "mp3" && type !== "flac") return null;
  // The app would play a file:// URL as readily as a stream; only the web is
  // a place a song comes from.
  const url = safeURL(data.audioHttpsUrl) || safeURL(data.audioUrl);
  if (!url) return null;
  return {
    url,
    type,
    bitRate: Number(data.bitrate) || br,
    size: parseSize(data.size),
    level: type === "flac" ? "lossless" : Number(data.bitrate) >= 320 ? "high" : "standard",
  };
}

const LEVELS = { standard: 1, high: 2, lossless: 3 };

export async function stream({ id, quality = "high" }) {
  const raw = digits(id);
  // The listener may pin a quality in the plugin's settings; otherwise the
  // player's choice stands.
  const pinned = host.setting("quality");
  const chosen = BITRATES[pinned] ? pinned : quality;
  const asked = BITRATES[chosen] ? chosen : "high";
  const until = deadline();
  let best = null;
  for (const br of BITRATES[asked]) {
    if (expired(until)) break;
    let found;
    try {
      found = await audioFor(raw, br, until);
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
  if (!best) throw fail("unavailable", t("Bodian Music can’t play this song"));
  return {
    url: best.url,
    type: best.type,
    size: best.size,
    bitRate: best.bitRate,
    quality: best.level,
    headers: { "User-Agent": UA },
  };
}
