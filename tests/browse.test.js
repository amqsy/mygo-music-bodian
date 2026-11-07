import test from "node:test";
import assert from "node:assert/strict";

import { api, loadPlugin, ok, track } from "./harness.js";

const playlist = (over = {}) => ({
  id: 5,
  name: "自驾兜风",
  pic: "http://img.example/pl.jpg",
  creatorId: 1,
  creatorName: "某人",
  description: "",
  musicCount: 20,
  sourceType: 4,
  ...over,
});

const tree = {
  categories: [
    { id: 67, name: "主题", subCategories: [{ id: 77, name: "网红" }, { id: 78, name: "纯音乐" }] },
    { id: 69, name: "流派", subCategories: [] },
  ],
};

test("the playlist square offers the way to its categories", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/category/playlist": ok({ playLists: [], total: 0 }) }),
  });
  const page = await mod.browse({ page: "square" });
  const more = page.sections.find((section) => section.title === "More");
  assert.ok(more, "no More section");
  assert.ok(more.links.some((link) => link.page === "cat"));
});

test("the category page lists each group's leaves", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/category/list": ok(tree) }),
  });
  const page = await mod.browse({ page: "cat" });
  assert.equal(page.title, "Categories");
  assert.deepEqual(page.sections.map((section) => section.title), ["主题"]);
  assert.deepEqual(
    page.sections[0].links.map((link) => link.page),
    ["cat-77", "cat-78"],
  );
});

test("a leaf category shows its playlists and pages on", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "service/category/list": ok(tree),
      "service/category/110/playlist": ok({ playLists: [playlist()], total: 200 }),
    }),
  });
  const page = await mod.browse({ page: "cat-110" });
  assert.equal(page.sections[0].playlists[0].name, "自驾兜风");
  const more = page.sections.find((section) => section.title === "More");
  assert.ok(more.links.some((link) => link.page === "cat-110-2"));
  assert.equal(calls.find((call) => call.url.pathname.endsWith("/110/playlist")).url.searchParams.get("pn"), "1");

  await mod.browse({ page: "cat-110-3" });
  assert.equal(calls.at(-1).url.searchParams.get("pn"), "3");
});

test("topics are cards that open like playlists", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/music_topics/list": ok({
        total: 40,
        lists: [{ id: 154, name: "写作业📜可以听什么歌？", description: "肝作业", pic: "http://img.example/t.jpg" }],
      }),
    }),
  });
  const page = await mod.browse({ page: "topics" });
  assert.equal(page.title, "Topics");
  const card = page.sections[0].playlists[0];
  assert.equal(card.id, "tp-154");
  assert.equal(card.name, "写作业📜可以听什么歌？");
  assert.equal(card.imageUrl, "http://img.example/t.jpg");
  const more = page.sections.find((section) => section.title === "More");
  assert.ok(more.links.some((link) => link.page === "topics-2"));
});

test("a topic opens the playlist behind it", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/music_topics/details": ok({
        id: 154,
        name: "写作业📜可以听什么歌？",
        description: "肝作业了",
        pic: "http://img.example/t.jpg",
        playlistId: 1566544,
      }),
      "service/playlist/info/1566544": (url) =>
        url.searchParams.get("source") === "4"
          ? ok({ id: 1566544, name: "作业歌单", pic: "http://img.example/pl.jpg", musicCount: 1, sourceType: 4 })
          : ok({ id: 0, name: "" }),
      "service/playlist/1566544/musicList": ok({ total: 1, list: [track()] }),
    }),
  });
  const opened = await mod.playlist({ id: "tp-154" });
  assert.equal(opened.id, "tp-154");
  assert.equal(opened.name, "写作业📜可以听什么歌？");
  assert.equal(opened.imageUrl, "http://img.example/t.jpg");
  assert.equal(opened.tracks.length, 1);
  assert.equal(opened.tracks[0].name, "晴天");
});

test("a topic without a playlist falls back to the songs its clips name", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "service/music_topics/details": ok({ id: 9, name: "冷门话题", description: "", pic: "" }),
      "service/music_topics/music_list": ok({
        lists: [{ musicId: 228908, description: "好听" }, { musicId: 228908 }, { musicId: 0 }],
      }),
      "service/music/info": ok(track()),
    }),
  });
  const opened = await mod.playlist({ id: "tp-9" });
  assert.equal(opened.tracks.length, 1);
  const asked = calls.filter((call) => call.url.pathname.endsWith("/service/music/info"));
  assert.equal(asked.length, 1, "the same song was asked for twice");
});