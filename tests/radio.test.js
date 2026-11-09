import test from "node:test";
import assert from "node:assert/strict";

import { api, loadPlugin, ok, track } from "./harness.js";

const scenes = {
  result: [
    { id: 110, name: "开车", pic: "http://img.example/drive.jpg" },
    { id: 112, name: "学习", pic: "http://img.example/study.jpg" },
  ],
};

test("stations list the guess stream and the radio hub's scenes", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/radio/scene_radio": ok(scenes) }),
  });
  const list = await mod.stations();
  assert.deepEqual(list.map((station) => station.id), ["guess", "scene-110", "scene-112"]);
  assert.equal(list[0].name, "Guess You Like");
  assert.equal(list[1].name, "开车");
  assert.equal(list[1].imageUrl, "http://img.example/drive.jpg");
});

test("the scene category's other scenes are stations too", async () => {
  const scene = (id, name) => ({ id, name, pic: `http://img.example/${id}.jpg` });
  const { mod } = await loadPlugin({
    handler: api({
      "service/radio/scene_radio": ok({ result: [scene(110, "开车"), scene(114, "睡前")] }),
      "service/category/list": ok({
        categories: [
          { id: 71, name: "心情", subCategories: [{ id: 102, name: "燃" }] },
          {
            id: 72,
            name: "场景",
            subCategories: [
              { id: 110, name: "开车" },
              { id: 111, name: "运动" },
              { id: 112, name: "学习" },
              { id: 113, name: "夜店" },
              { id: 114, name: "睡前" },
              { id: 116, name: "深夜" },
              { id: 117, name: "店铺" },
            ],
          },
        ],
      }),
    }),
  });
  const list = await mod.stations();
  assert.deepEqual(list.map((station) => station.id), [
    "guess",
    "scene-110",
    "scene-114",
    "scene-111",
    "scene-112",
    "scene-113",
    "scene-116",
    "scene-117",
  ]);
});

test("a scene the hub has no picture for takes its first song's cover", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/radio/scene_radio": ok({
        result: [{ id: 110, name: "开车", pic: "http://img.example/drive.jpg" }],
      }),
      "service/category/list": ok({
        categories: [{ id: 72, name: "场景", subCategories: [{ id: 113, name: "夜店" }] }],
      }),
      "service/category/113/musics": ok({
        musicList: [track({ id: 5, albumPic: "http://img.example/club.webp" })],
      }),
    }),
  });
  const list = await mod.stations();
  const club = list.find((station) => station.id === "scene-113");
  assert.equal(club.imageUrl, "http://img.example/club.jpg");
});

test("scenes stand on the category tree when the radio hub fails", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/category/list": ok({
        categories: [{ id: 72, name: "场景", subCategories: [{ id: 113, name: "夜店" }] }],
      }),
    }),
  });
  const list = await mod.stations();
  assert.deepEqual(list.map((station) => station.id), ["guess", "scene-113"]);
});

test("the scenes it always had stand in when the hub answers with none", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/radio/scene_radio": ok({ result: [] }) }),
  });
  const list = await mod.stations();
  assert.deepEqual(list.map((station) => station.id), [
    "guess",
    "scene-110",
    "scene-111",
    "scene-112",
    "scene-114",
  ]);
});

test("the guess station reads a page at a time and skips what it played", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "service/music/recommendList": (url) => {
        const pn = Number(url.searchParams.get("pn"));
        return ok({
          musicList: pn === 1
            ? [track({ id: 1 }), track({ id: 2 })]
            : [track({ id: 2 }), track({ id: 3 })],
        });
      },
    }),
  });
  const first = await mod.stationNext({ id: "guess" });
  assert.deepEqual(first.map((song) => song.id), ["1", "2"]);
  const second = await mod.stationNext({ id: "guess" });
  assert.deepEqual(second.map((song) => song.id), ["3"]);
  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get("pn")),
    ["1", "2"],
  );
});

test("a scene station reads that scene's songs", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "service/category/110/musics": ok({ musicList: [track({ id: 9 })] }),
    }),
  });
  const songs = await mod.stationNext({ id: "scene-110" });
  assert.deepEqual(songs.map((song) => song.id), ["9"]);
  const url = calls[0].url;
  assert.equal(url.pathname, "/api/service/category/110/musics");
  assert.equal(url.searchParams.get("pn"), "1");
  assert.equal(url.searchParams.get("rn"), "30");
  assert.equal(calls.length, 1);
});

test("a scene the account has picks for is read once", async () => {
  const { mod, calls } = await loadPlugin({
    storage: { session: { uid: "68813768", token: "TOKEN" } },
    handler: api({ "service/category/114/musics": ok({ musicList: [track({ id: 7 })] }) }),
  });
  const songs = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(songs.map((song) => song.id), ["7"]);
  assert.equal(calls.length, 1);
});

test("a scene the account has no picks for is asked again from a fresh device", async () => {
  const session = { uid: "68813768", token: "TOKEN" };
  const device = "0123456789abcdef0123456789abcdef";
  const { mod, calls } = await loadPlugin({
    storage: { session, devid: device },
    handler: async (url, init) => {
      if (url.pathname !== "/api/service/category/114/musics") return { code: 404, msg: "no route", data: {} };
      return ok({ musicList: init.headers.devid === device ? [] : [track({ id: 7 }), track({ id: 8 })] });
    },
  });
  const songs = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(songs.map((song) => song.id), ["7", "8"]);
  assert.equal(calls.length, 2);
  // The first read is the normal one, with the session in the query and
  // headers; the second keeps it in the headers, where a fresh device's
  // query uid would ask for the account's empty picks instead of the songs.
  assert.equal(calls[0].url.searchParams.get("uid"), "68813768");
  assert.equal(calls[0].headers.uid, "68813768");
  assert.equal(calls[1].url.searchParams.get("uid"), null);
  assert.equal(calls[1].headers.uid, "68813768");
  assert.equal(calls[0].headers.token, "TOKEN");
  assert.equal(calls[1].headers.token, "TOKEN");
  // The device that signed in can have heard the scene already; the second
  // read goes out as a device Bodian has never seen.
  assert.equal(calls[0].headers.devid, device);
  assert.notEqual(calls[1].headers.devid, device);
  assert.equal(calls[1].headers.qimei36, calls[1].headers.devid);
});

test("a scene that has run out starts its songs again", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "service/category/114/musics": (url) =>
        ok({ musicList: Number(url.searchParams.get("pn")) === 1 ? [track({ id: 1 }), track({ id: 2 })] : [] }),
    }),
  });
  const first = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(first.map((song) => song.id), ["1", "2"]);
  const second = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(second.map((song) => song.id), ["1", "2"]);
  // The second call reads on past the end, then replays what it listed.
  const pages = calls
    .filter((call) => call.url.pathname.endsWith("/category/114/musics"))
    .map((call) => Number(call.url.searchParams.get("pn")));
  assert.deepEqual(pages, [1, 2, 3, 4]);
  const third = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(third.map((song) => song.id), ["1", "2"]);
});

test("a scene goes on with songs like its last one", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/category/114/musics": (url) =>
        ok({ musicList: Number(url.searchParams.get("pn")) === 1 ? [track({ id: 1 })] : [] }),
      "rec/music/similar/list": ok({ musicList: [track({ id: 2 }), track({ id: 3 })] }),
    }),
  });
  const first = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(first.map((song) => song.id), ["1"]);
  const second = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(second.map((song) => song.id), ["2", "3"]);
});

test("a station with no similar songs goes on with the recommendation stream", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/category/114/musics": (url) =>
        ok({ musicList: Number(url.searchParams.get("pn")) === 1 ? [track({ id: 1 })] : [] }),
      "rec/music/similar/list": ok({ musicList: [] }),
      "service/music/recommendList": ok({ musicList: [track({ id: 9 })] }),
    }),
  });
  const first = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(first.map((song) => song.id), ["1"]);
  const second = await mod.stationNext({ id: "scene-114" });
  assert.deepEqual(second.map((song) => song.id), ["9"]);
});

test("a station that is not one of ours is unavailable", async () => {
  const { mod } = await loadPlugin({ handler: api({}) });
  await assert.rejects(
    () => mod.stationNext({ id: "not-a-station" }),
    (error) => error.code === "unavailable",
  );
});

test("home carries guess you like", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/music/recommendList": ok({ musicList: [track({ id: 1 }), track({ id: 2 })] }),
    }),
  });
  const page = await mod.home();
  const titles = page.sections.map((section) => section.title);
  assert.ok(titles.includes("Guess You Like"), titles.join(","));
  const guess = page.sections.find((section) => section.title === "Guess You Like");
  assert.equal(guess.tracks.length, 2);
});