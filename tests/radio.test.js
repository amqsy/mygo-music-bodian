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