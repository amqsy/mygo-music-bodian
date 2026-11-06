// A fake app for the plugin: host, fetch and a place to watch what it asks
// for, so the plugin can be tested without MyGo Music or the network.
import { readFile } from "node:fs/promises";

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

let loaded = 0;

// loadPlugin imports index.js afresh, with host and fetch as the test says.
// handler(url, init) answers the envelope an endpoint would.
export async function loadPlugin({ storage = {}, settings = {}, handler, locales = null } = {}) {
  const state = new Map(Object.entries(clone(storage)));
  const calls = [];
  const prompts = [];

  globalThis.host = {
    platform: "linux",
    arch: "x64",
    dir: "/plugin",
    dataDir: "/data",
    storage: {
      get: (key) => clone(state.get(key)),
      set: (key, value) => state.set(key, clone(value)),
      remove: (key) => state.delete(key),
    },
    setting: (key) => settings[key] || "",
    language: () => "zh-CN",
    t: (text) => (locales && locales[text]) || text,
    signInPrompt: (prompt) => prompts.push(prompt),
    openURL: () => {},
  };

  globalThis.fetch = async (address, init = {}) => {
    const url = new URL(String(address));
    const call = { url, method: (init.method || "GET").toUpperCase(), headers: init.headers || {}, body: init.body };
    calls.push(call);
    const answer = await handler(url, init, call);
    return {
      ok: true,
      status: 200,
      json: async () => answer,
      text: async () => JSON.stringify(answer),
      headers: { getSetCookie: () => [] },
    };
  };

  loaded += 1;
  const mod = await import(`../index.js?test=${loaded}`);
  return { mod, calls, prompts, storage: state, settings };
}

// api answers what the Bodian API would: an envelope with a code.
export function api(routes) {
  return async (url) => {
    const path = url.pathname.replace(/^\/api\//, "");
    const route = routes[path];
    if (!route) return { code: 404, msg: "no route", data: {} };
    return typeof route === "function" ? route(url) : route;
  };
}

// ok wraps data in the envelope the API answers with.
export const ok = (data) => ({ code: 200, msg: "success", data });

export const track = (over = {}) => ({
  id: 228908,
  name: "晴天",
  albumId: 1293,
  album: "叶惠美",
  albumPic: "http://img.example/cover.jpg",
  artist: "周杰伦",
  artistId: 336,
  artists: [{ id: 336, name: "周杰伦", pic: "http://img.example/artist.jpg" }],
  duration: 269,
  online: 1,
  payInfo: { paytype: 3, feeType: { song: "1", vip: "1" }, cannotOnlinePlay: 0 },
  mediaBasicInfo: { gain: -6.5, peak: 0.9 },
  ...over,
});

export const playlistInfo = (over = {}) => ({
  id: 9,
  name: "测试歌单",
  pic: "http://img.example/pl.jpg",
  creatorId: 68813768,
  creatorName: "小音波",
  description: "一张歌单",
  musicCount: 2,
  playNum: 1234,
  sourceType: 5,
  ...over,
});

export const localeFile = async () =>
  JSON.parse(await readFile(new URL("../locales/zh-CN.json", import.meta.url), "utf8"));
