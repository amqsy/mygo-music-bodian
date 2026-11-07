import test from "node:test";
import assert from "node:assert/strict";

import { api, loadPlugin, ok, playlistInfo, track, localeFile } from "./harness.js";

const session = { uid: "68813768", token: "TOKEN" };

test("search maps a Bodian song to a MyGo track", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({ "search/music/list": ok({ total: 1, resultList: [track()] }) }),
  });
  const result = await mod.search({ query: "晴天", kind: "tracks", offset: 0 });
  assert.equal(result.tracks.length, 1);
  const song = result.tracks[0];
  assert.equal(song.id, "228908");
  assert.equal(song.name, "晴天");
  assert.equal(song.duration, 269000);
  assert.equal(song.album.id, "al-1293");
  assert.equal(song.album.name, "叶惠美");
  assert.equal(song.artists[0].id, "ar-336");
  assert.equal(song.artists[0].name, "周杰伦");
  assert.equal(song.unavailable, false);
  assert.equal(song.url, "https://www.kuwo.cn/play_detail/228908");

  const query = calls[0].url.searchParams;
  assert.equal(query.get("keyword"), "晴天");
  assert.equal(query.get("pn"), "0");
  assert.equal(query.get("rn"), "30");
  assert.equal(query.get("correct"), "1");
});

test("a song taken down is marked unavailable", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "search/music/list": ok({ resultList: [track({ online: 0 })] }) }),
  });
  const result = await mod.search({ query: "x", kind: "tracks" });
  assert.equal(result.tracks[0].unavailable, true);
});

test("search playlists read their snake_case fields, with their source", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "search/playlist/list": ok({
        total: 1,
        resultList: [
          { id: 77, name: "列表", pic: "http://img.example/p.jpg", creator_id: 5, creator_name: "某人", playnum: 9, musicnum: 12, source: 4 },
        ],
      }),
    }),
  });
  const result = await mod.search({ query: "列表", kind: "playlists" });
  const playlist = result.playlists[0];
  assert.equal(playlist.id, "pl-4-77");
  assert.equal(playlist.name, "列表");
  assert.equal(playlist.trackCount, 12);
  assert.equal(playlist.owner, "某人");
  assert.equal(playlist.imageUrl, "http://img.example/p.jpg");
});

test("the session rides in the query as well as the headers", async () => {
  const { mod, calls } = await loadPlugin({
    storage: { session },
    handler: api({ "search/music/list": ok({ resultList: [] }) }),
  });
  await mod.search({ query: "x", kind: "tracks" });
  const call = calls[0];
  assert.equal(call.url.searchParams.get("uid"), "68813768");
  assert.equal(call.url.searchParams.get("token"), "TOKEN");
  assert.equal(call.headers.uid, "68813768");
  assert.equal(call.headers.token, "TOKEN");
  assert.equal(call.headers.devid.length, 32);
});

test("a playlist of an unknown source is found by asking the sources", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/playlist/info/9": (url) => {
        const source = url.searchParams.get("source");
        // Sources the playlist isn't in answer a hollow entry.
        if (source === "4") return ok({ id: 9, name: "" });
        if (source === "13") return ok({ id: 9, name: "测试歌单", musicCount: 0 });
        if (source !== "5") return ok({ id: 0, name: "" });
        return ok(playlistInfo());
      },
      "service/playlist/9/musicList": (url) =>
        url.searchParams.get("source") === "5"
          ? ok({ total: 1, list: [track()] })
          : ok({ total: 0, list: [] }),
    }),
  });
  const playlist = await mod.playlist({ id: "pl-0-9" });
  assert.equal(playlist.name, "测试歌单");
  assert.equal(playlist.id, "pl-5-9");
  assert.equal(playlist.mine, true);
  assert.equal(playlist.tracks.length, 1);
  assert.equal(playlist.tracks[0].name, "晴天");
});

test("my playlists are marked as the listener's own", async () => {
  const { mod } = await loadPlugin({
    storage: { session },
    handler: api({
      // userCreate answers no sourceType, unlike the playlist square.
      "service/playlist/userCreate": ok({
        playLists: [{ id: 9, name: "测试歌单", creatorName: "我", musicCount: 2 }],
      }),
      "service/collect/4/list": ok({ playLists: [] }),
      "service/playlist/info/9": (url) => {
        const source = url.searchParams.get("source");
        if (source === "4") return ok({ id: 9, name: "" });
        if (source === "13") return ok({ id: 9, name: "测试歌单", musicCount: 0 });
        return ok(playlistInfo());
      },
      "service/playlist/9/musicList": (url) =>
        url.searchParams.get("source") === "5"
          ? ok({ total: 2, list: [track(), track({ id: 228909, name: "七里香" })] })
          : ok({ total: 0, list: [] }),
    }),
  });
  const [playlist] = await mod.playlists();
  assert.equal(playlist.id, "pl-5-9");
  assert.equal(playlist.trackCount, 2);
  assert.equal(playlist.mine, true);

  const opened = await mod.playlist({ id: playlist.id });
  assert.equal(opened.id, "pl-5-9");
  assert.equal(opened.trackCount, 2);
  assert.equal(opened.tracks.length, 2);
  assert.equal(opened.tracks[1].name, "七里香");
});

test("a chart opens by its own id", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/bang/16/musics": ok({ id: 16, name: "热歌榜", pic: "", pub: "2026-11-07", total: 1, musics: [track()] }),
    }),
  });
  const playlist = await mod.playlist({ id: "bang-16" });
  assert.equal(playlist.name, "热歌榜");
  assert.equal(playlist.tracks.length, 1);
});

test("charts without an id are left out", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/home/bangNew": ok([
        { bangList: [{ id: 16, name: "热歌榜", total: 2 }, { id: null, name: "H5 榜", musics: [] }] },
      ]),
    }),
  });
  const page = await mod.browse({ page: "charts" });
  assert.equal(page.sections[0].playlists.length, 1);
  assert.equal(page.sections[0].playlists[0].id, "bang-16");
});

test("comments are asked for as the Android app does", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "comments/v3/hot": ok({
        comment_list: [
          { id: 1, uid: 2, nickname: "听众", content: "好听", createTime: "2026-01-02 03:04:05", likeCount: 5, like: 1 },
        ],
        comment_total: 1,
        more: false,
      }),
    }),
  });
  const page = await mod.comments({ trackId: "228908", offset: 0 });
  assert.equal(page.total, 1);
  assert.equal(page.comments[0].author, "听众");
  assert.equal(page.comments[0].text, "好听");
  assert.equal(page.comments[0].likes, 5);
  assert.equal(page.comments[0].liked, true);
  assert.ok(page.comments[0].time > 0);
  assert.equal(calls[0].headers.plat, "android");
  assert.equal(calls[0].url.searchParams.get("moduleId"), "228908");
});

test("lyrics are base64, in UTF-8", async () => {
  const lrc = "[00:01.00]晴天\n[00:04.00]故事的小黄花";
  const { mod } = await loadPlugin({
    handler: async (url) => {
      assert.equal(url.host, "mlyric.kuwo.cn");
      return { code: 200, data: { content: Buffer.from(lrc, "utf8").toString("base64") } };
    },
  });
  const lyrics = await mod.lyrics({ id: "228908" });
  assert.equal(lyrics.lrc, lrc);
});

test("renaming a playlist sends PUT with its whole details", async () => {
  const { mod, calls } = await loadPlugin({
    storage: { session },
    handler: api({
      "service/playlist/info/9": ok(playlistInfo()),
      "service/playlist": ok({}),
    }),
  });
  await mod.renamePlaylist({ id: "pl-5-9", name: "新名字" });
  const put = calls.find((call) => call.method === "PUT");
  assert.ok(put, "no PUT was sent");
  const body = JSON.parse(put.body);
  assert.equal(body.id, 9);
  assert.equal(body.name, "新名字");
  assert.equal(body.description, "一张歌单");
  assert.equal(body.pic, "http://img.example/pl.jpg");
});

test("deleting a playlist sends DELETE", async () => {
  const { mod, calls } = await loadPlugin({
    storage: { session },
    handler: api({ "service/playlist": ok({}) }),
  });
  await mod.deletePlaylist({ id: "pl-5-9" });
  const del = calls.find((call) => call.method === "DELETE");
  assert.ok(del, "no DELETE was sent");
  assert.deepEqual(JSON.parse(del.body), { playlistIds: [9] });
});

test("a session Bodian refuses asks the listener to sign in again", async () => {
  const { mod, storage } = await loadPlugin({
    storage: { session },
    handler: api({ "search/music/list": { code: -101, msg: "登录失效", data: {} } }),
  });
  await assert.rejects(
    () => mod.search({ query: "x", kind: "tracks" }),
    (error) => error.code === "signIn",
  );
  assert.equal(storage.get("session"), undefined);
});

test("signing in scans a QR code and keeps the session", async () => {
  let status = 0;
  const { mod, prompts, storage } = await loadPlugin({
    handler: api({
      "ucenter/login/qrCode": ok({ qrCode: "KEY" }),
      "ucenter/login/qrCodeStatus": () => ok({ status: status++ === 0 ? 1 : 3 }),
      "ucenter/users/login": ok({ id: 68813768, token: "TOK", userInfo: { nickname: "小音波", headImg: "http://a" } }),
      "ucenter/users/pub/68813768": ok({ userInfo: { id: 68813768, nickname: "小音波", headImg: "http://a" } }),
    }),
  });
  const profile = await mod.signIn();
  assert.equal(profile.id, "68813768");
  assert.equal(profile.name, "小音波");
  assert.ok(prompts.some((prompt) => prompt.qr && prompt.qr.includes("KEY")));
  assert.deepEqual(storage.get("session"), { uid: "68813768", token: "TOK" });
});

test("the plugin's quality setting overrides the player's", async () => {
  const { mod, calls } = await loadPlugin({
    settings: { quality: "standard" },
    handler: api({
      "play/music/v2/audioUrl": (url) =>
        ok({
          audioUrl: "https://bd-er.kuwo.cn/x.mp3",
          format: "mp3",
          bitrate: Number(url.searchParams.get("br")),
          size: "4.10Mb",
        }),
    }),
  });
  const stream = await mod.stream({ id: "228908", quality: "lossless" });
  assert.equal(stream.type, "mp3");
  assert.equal(stream.quality, "standard");
  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get("br")),
    ["128"],
  );
});

test("every string the plugin says has a Chinese translation", async () => {
  const locales = await localeFile();
  const source = await (await import("node:fs/promises")).readFile(new URL("../index.js", import.meta.url), "utf8");
  const keys = [...source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\(.)/g, "$1"));
  const missing = [...new Set(keys)].filter((key) => !(key in locales));
  assert.deepEqual(missing, [], `missing translations: ${missing.join(", ")}`);
});

test("typing gets suggestions, an empty box gets hot words", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "search/tip/v2/list": ok({
        resultList: [{ relword: "晴天" }, { relword: "晴天 周杰伦" }, { relword: "" }],
      }),
      "search/hot/list": ok({ resultList: [{ key: "热歌" }, { key: "新歌" }] }),
    }),
  });
  assert.deepEqual(await mod.suggest({ query: "晴" }), ["晴天", "晴天 周杰伦"]);
  assert.equal(calls[0].url.searchParams.get("keyword"), "晴");
  assert.deepEqual(await mod.suggest({ query: "  " }), ["热歌", "新歌"]);
});
