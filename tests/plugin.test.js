import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
    storage: { session },
    handler: api({
      "service/playlist/info/9": (url) => {
        // Bodian answers an empty playlist for a source it is not in.
        if (url.searchParams.get("source") !== "5") return ok({ id: 0, name: "" });
        return ok(playlistInfo());
      },
      "service/playlist/9/musicList": ok({ total: 1, list: [track()] }),
    }),
  });
  const playlist = await mod.playlist({ id: "pl-0-9" });
  assert.equal(playlist.name, "测试歌单");
  assert.equal(playlist.id, "pl-5-9");
  assert.equal(playlist.mine, true);
  assert.equal(playlist.tracks.length, 1);
  assert.equal(playlist.tracks[0].name, "晴天");
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

test("a profile that fails after login leaves the session in place", async () => {
  let status = 0;
  const { mod, storage } = await loadPlugin({
    handler: api({
      "ucenter/login/qrCode": ok({ qrCode: "KEY" }),
      "ucenter/login/qrCodeStatus": () => ok({ status: status++ === 0 ? 1 : 3 }),
      "ucenter/users/login": ok({ id: 68813768, token: "TOK" }),
      "ucenter/users/pub/68813768": { code: 500, msg: "boom", data: {} },
    }),
  });
  const profile = await mod.signIn();
  assert.equal(profile.id, "68813768");
  assert.equal(profile.name, "Bodian Music listener");
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

test("saved playlists are read past the first page, and mark the playlist saved", async () => {
  const { mod, calls } = await loadPlugin({
    storage: { session },
    handler: api({
      "service/playlist/userCreate": ok({ playLists: [] }),
      "service/collect/4/list": (url) => {
        const pn = Number(url.searchParams.get("pn"));
        const list = pn === 1
          ? Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `S${i}`, sourceType: 4 }))
          : [{ id: 2000, name: "最后一页", sourceType: 4 }];
        return ok({ playLists: list });
      },
      "service/playlist/info/2000": (url) =>
        url.searchParams.get("source") === "5"
          ? ok({ id: 2000, name: "最后一页", sourceType: 5, musicCount: 1, creatorId: 1 })
          : ok({ id: 0, name: "" }),
      "service/playlist/2000/musicList": ok({ total: 1, list: [track()] }),
    }),
  });
  const lists = await mod.playlists();
  assert.equal(lists.length, 101);
  assert.equal(lists.at(-1).name, "最后一页");
  assert.deepEqual(
    calls.filter((call) => call.url.pathname.endsWith("/collect/4/list")).map((call) => call.url.searchParams.get("pn")),
    ["1", "2"],
  );
  // The library lists it under source 4; a page found under 5 still says saved.
  const playlist = await mod.playlist({ id: "pl-5-2000" });
  assert.equal(playlist.saved, true);
});

test("a playlist from search is not the listener's own", async () => {
  const { mod } = await loadPlugin({
    storage: { session },
    handler: api({
      "search/playlist/list": ok({
        resultList: [{ id: 77, name: "别人的歌单", source: 5, creator_name: "别人", musicnum: 1 }],
      }),
      "service/playlist/info/77": (url) =>
        url.searchParams.get("source") === "5"
          ? ok({ id: 77, name: "别人的歌单", creatorId: 424242, sourceType: 5, musicCount: 1 })
          : ok({ id: 0, name: "" }),
      "service/playlist/77/musicList": ok({ total: 1, list: [track()] }),
    }),
  });
  const found = await mod.search({ query: "x", kind: "playlists" });
  assert.equal(found.playlists[0].id, "pl-5-77");
  const playlist = await mod.playlist({ id: found.playlists[0].id });
  assert.equal(playlist.mine, false);
});

test("an album says whether the listener saved it", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/album/1293": ok({ albumInfo: { id: 1293, name: "叶惠美", artists: [], showtime: "2003-07-31" } }),
      "service/album/music/1293": ok({ resultList: [track()] }),
      "service/collect/multipleState": ok({ result: [{ id: 1293, collect: 1 }] }),
    }),
  });
  const page = await mod.album({ id: "al-1293" });
  assert.equal(page.album.name, "叶惠美");
  assert.equal(page.album.saved, true);
  assert.equal(page.tracks.length, 1);
});

test("a chart is a page, not a playlist to save", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/bang/16/musics": ok({ id: 16, name: "热歌榜", total: 1, musics: [track()] }),
    }),
  });
  const page = await mod.playlist({ id: "bang-16" });
  assert.equal(page.mine, true);
  await assert.rejects(
    () => mod.savePlaylist({ id: "bang-16", on: true }),
    (error) => error.code === "unsupported",
  );
});

test("a late signed-out answer leaves a newer session alone", async () => {
  let release;
  const { mod, storage } = await loadPlugin({
    storage: { session: { uid: "111", token: "OLD" } },
    handler: (url) => {
      if (url.pathname.endsWith("/search/music/list")) {
        return new Promise((resolve) => {
          release = () => resolve({ code: -101, msg: "登录失效", data: {} });
        });
      }
      return { code: 404, msg: "no route", data: {} };
    },
  });
  const pending = mod.search({ query: "x", kind: "tracks" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(release, "the search did not go out");
  storage.set("session", { uid: "222", token: "NEW" });
  release();
  await assert.rejects(pending, (error) => error.code === "signIn");
  assert.deepEqual(storage.get("session"), { uid: "222", token: "NEW" });
});

test("a comment's time is read as China time", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "comments/v3/hot": ok({
        comment_list: [
          { id: 1, content: "好听", publishTime: "21-12-13 17:59", createTime: "2021-12-13", like: 0 },
        ],
        comment_total: 1,
        more: false,
      }),
    }),
  });
  const page = await mod.comments({ trackId: "228908", offset: 0 });
  assert.equal(page.comments[0].time, Date.UTC(2021, 11, 13, 9, 59));
});

test("a stream that is not a web address is passed over", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "play/music/v2/audioUrl": (url) => {
        if (url.searchParams.get("br") === "20000") {
          return ok({ audioUrl: "file:///etc/passwd", format: "mp3", bitrate: 320 });
        }
        return ok({
          audioUrl: "http://bd-er.kuwo.cn/ok.mp3",
          audioHttpsUrl: "https://bd-er.kuwo.cn/ok.mp3",
          format: "mp3",
          bitrate: 320,
        });
      },
    }),
  });
  const stream = await mod.stream({ id: "1", quality: "high" });
  assert.equal(stream.url, "https://bd-er.kuwo.cn/ok.mp3");
  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get("br")),
    ["20000", "320"],
  );
});

test("home reports an error when nothing loads", async () => {
  const { mod } = await loadPlugin({ handler: api({}) });
  await assert.rejects(() => mod.home());
});

test("an HTTP failure is reported with its status", async () => {
  const { mod } = await loadPlugin({
    handler: async () => ({ __response: { status: 502, body: "<html>bad gateway</html>" } }),
  });
  await assert.rejects(() => mod.search({ query: "x", kind: "tracks" }), /502/);
});

test("the manifest's name, pages and settings are translated", async () => {
  const locales = await localeFile();
  const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
  const keys = [
    manifest.name,
    ...(manifest.navigation || []).map((item) => item.title),
    ...(manifest.settings || []).flatMap((setting) => [setting.label, setting.help].filter(Boolean)),
  ];
  const missing = [...new Set(keys)].filter((key) => !(key in locales));
  assert.deepEqual(missing, []);
});

test("a topic falls back to its clips when the playlist's songs don't load", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/music_topics/details": ok({ id: 9, name: "冷门话题", description: "", pic: "", playlistId: 1566544 }),
      "service/playlist/info/1566544": (url) =>
        url.searchParams.get("source") === "5"
          ? ok({ id: 1566544, name: "话题歌单", sourceType: 5, musicCount: 1 })
          : ok({ id: 0, name: "" }),
      "service/playlist/1566544/musicList": { code: 500, msg: "boom", data: {} },
      "service/music_topics/music_list": ok({ lists: [{ musicId: 228908 }] }),
      "service/music/info": ok(track()),
    }),
  });
  const opened = await mod.playlist({ id: "tp-9" });
  assert.equal(opened.tracks.length, 1);
  assert.equal(opened.tracks[0].name, "晴天");
});

test("a topic whose own playlist can't be reached falls back to its clips, not another list", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/music_topics/details": ok({ id: 9, name: "冷门话题", description: "", pic: "", playlistId: 1566544 }),
      "service/playlist/info/1566544": (url) => {
        if (url.searchParams.get("source") === "5") throw new Error("network down");
        return ok({ id: 1566544, name: "默认列表", sourceType: 4, musicCount: 1 });
      },
      "service/playlist/1566544/musicList": ok({ total: 1, list: [track({ id: 999, name: "别人的歌" })] }),
      "service/music_topics/music_list": ok({ lists: [{ musicId: 228908 }] }),
      "service/music/info": ok(track()),
    }),
  });
  const opened = await mod.playlist({ id: "tp-9" });
  assert.equal(opened.tracks[0].name, "晴天");
});

test("signing out forgets the last account's playlists", async () => {
  const { mod } = await loadPlugin({
    storage: { session: { uid: "68813768", token: "TOKEN" } },
    handler: api({
      "service/playlist/userCreate": ok({ playLists: [{ id: 100, name: "我的", sourceType: 5 }] }),
      "service/collect/4/list": ok({ playLists: [] }),
      "service/playlist/info/100": ok({ id: 100, name: "我的", sourceType: 5, musicCount: 1, creatorId: 0 }),
      "service/playlist/100/musicList": ok({ total: 1, list: [track()] }),
    }),
  });
  await mod.playlists();
  mod.signOut();
  const playlist = await mod.playlist({ id: "pl-5-100" });
  assert.equal(playlist.mine, false);
});

test("an own playlist found through the square is still Mine", async () => {
  const { mod } = await loadPlugin({
    storage: { session },
    handler: api({
      "service/playlist/info/9": (url) =>
        url.searchParams.get("source") === "4"
          ? ok({ id: 9, name: "我的歌单", creatorId: 68813768, sourceType: 4, musicCount: 1 })
          : ok({ id: 0, name: "" }),
      "service/playlist/9/musicList": ok({ total: 1, list: [track()] }),
    }),
  });
  const playlist = await mod.playlist({ id: "pl-4-9" });
  assert.equal(playlist.mine, true);
  assert.equal(playlist.id, "pl-5-9");
});

test("a like during an in-flight enumeration is not lost", async () => {
  let release;
  let first = true;
  const { mod } = await loadPlugin({
    storage: { session },
    handler: api({
      "service/playlist/fond": ok({ id: 13 }),
      "service/playlist/13/musicList": () => {
        if (!first) return ok({ total: 1, list: [track({ id: 2 })] });
        first = false;
        return new Promise((resolve) => {
          release = () => resolve(ok({ total: 0, list: [] }));
        });
      },
      "service/playlist/music": ok({}),
    }),
  });
  const pending = mod.isLiked({ ids: ["2"] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(release, "the enumeration did not start");
  await mod.like({ id: "2", on: true });
  release();
  await pending;
  const after = await mod.isLiked({ ids: ["2"] });
  assert.equal(after["2"], true);
});

test("a web audioUrl is used when audioHttpsUrl is not", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "play/music/v2/audioUrl": ok({
        audioUrl: "http://bd-er.kuwo.cn/ok.mp3",
        audioHttpsUrl: "file:///etc/passwd",
        format: "mp3",
        bitrate: 320,
      }),
    }),
  });
  const stream = await mod.stream({ id: "1", quality: "high" });
  assert.equal(stream.url, "http://bd-er.kuwo.cn/ok.mp3");
});

test("a signed-in home doesn't ask for a sign-in", async () => {
  const { mod } = await loadPlugin({
    storage: { session },
    handler: api({ "service/music/recommendList": ok({ musicList: [track()] }) }),
  });
  const page = await mod.home();
  assert.equal(page.subtitle, "Bodian Music");
});
