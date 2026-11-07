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

test("the playlist square offers the way to its categories above the grid", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/category/playlist": ok({ playLists: [playlist()], total: 200 }) }),
  });
  const page = await mod.browse({ page: "square" });
  const first = page.sections[0];
  assert.equal(first.title, undefined, "the page title is repeated as a section");
  assert.ok(first.links.some((link) => link.page === "cat"), "the categories are not at the top");
  assert.equal(first.playlists, undefined, "the grid comes before the categories");
  assert.equal(page.sections[1].playlists[0].name, "自驾兜风");
  const more = page.sections.find((section) => section.title === "More");
  assert.ok(more.links.some((link) => link.page === "square-2"));
  assert.ok(!more.links.some((link) => link.page === "cat"), "the categories are also at the bottom");
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

test("an empty category says so", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/category/list": ok(tree),
      "service/category/110/playlist": ok({ playLists: [], total: 0 }),
    }),
  });
  const page = await mod.browse({ page: "cat-110" });
  assert.equal(page.sections[0].empty, "No playlists in this category yet");
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
  const { mod, calls } = await loadPlugin({
    handler: api({
      "service/music_topics/details": ok({
        id: 154,
        name: "写作业📜可以听什么歌？",
        description: "肝作业了",
        pic: "http://img.example/t.jpg",
        playlistId: 1566544,
      }),
      // The id also names one of the square's playlists (4). The topic's own
      // is a listener's (5), which is the one to open.
      "service/playlist/info/1566544": (url) =>
        url.searchParams.get("source") === "5"
          ? ok({ id: 1566544, name: "作业歌单", pic: "http://img.example/pl.jpg", musicCount: 1, sourceType: 5 })
          : url.searchParams.get("source") === "4"
            ? ok({ id: 1566544, name: "默认列表", pic: "", musicCount: 95, sourceType: 4 })
            : ok({ id: 0, name: "" }),
      "service/playlist/1566544/musicList": (url) =>
        url.searchParams.get("source") === "5"
          ? ok({ total: 1, list: [track()] })
          : ok({ total: 1, list: [track({ id: 999, name: "别人的默认列表" })] }),
    }),
  });
  const opened = await mod.playlist({ id: "tp-154" });
  assert.equal(opened.id, "tp-154");
  assert.equal(opened.name, "写作业📜可以听什么歌？");
  assert.equal(opened.imageUrl, "http://img.example/t.jpg");
  assert.equal(opened.tracks.length, 1);
  assert.equal(opened.tracks[0].name, "晴天");
  // A topic is a page, not a playlist the listener can collect.
  assert.equal(opened.mine, true);
  const info = calls.find((call) => call.url.pathname.endsWith("/1566544"));
  assert.equal(info.url.searchParams.get("source"), "5");
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

test("the music calendar shows a day a card and pages back", async () => {
  const days = Array.from({ length: 29 }, (_, i) => ({
    id: 718 - i,
    title: `第 ${i + 1} 天`,
    pic: "http://img.example/cal.jpg",
    tag: "音乐经典时刻",
    showDate: "2026-11-07",
    sourceType: 2,
    source: 825441 + i,
  }));
  // A day with no song to open is left off rather than shown as a dead card.
  days.push({ id: 1, title: "没有歌的一天", source: 0 });
  // So is an entry of a kind this page has no way to open.
  days.push({ id: 2, title: "不是单曲的一天", source: 999, sourceType: 1 });
  const { mod, calls } = await loadPlugin({
    handler: api({
      "service/musicCalendar/list/history": ok({ list: days }),
      "service/music/info": (url) => {
        const id = Number(url.searchParams.get("musicId"));
        return ok(track({ id, name: `歌 ${id}` }));
      },
    }),
  });
  const page = await mod.browse({ page: "calendar" });
  assert.equal(page.title, "Music Calendar");
  assert.equal(page.sections[0].playlists.length, 29, "the day without a song is left off");
  assert.ok(!page.sections[0].playlists.some((card) => card.id.includes("999")), "an entry of another kind is left off");
  assert.equal(calls[0].url.searchParams.get("rn"), "30", "the page size the endpoint needs");
  const card = page.sections[0].playlists[0];
  assert.equal(card.id, "cal-718-825441", "the story's own id leads");
  assert.equal(card.name, "第 1 天");
  assert.equal(card.imageUrl, "http://img.example/cal.jpg");
  assert.equal(card.description, "音乐经典时刻 · 2026-11-07");
  assert.equal(card.owner, "歌 825441 · 周杰伦", "the card names the song");
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/service/music/info")).length, 29,
    "an entry that has no song is not asked for");
  const more = page.sections.find((section) => section.title === "More");
  assert.ok(more.links.some((link) => link.page === "calendar-2"));

  await mod.browse({ page: "calendar-2" });
  assert.equal(calls.at(-1).url.searchParams.get("pn"), "2");
});

test("two stories about the same song are two cards", async () => {
  const days = [
    { id: 718, title: "第一天的故事", tag: "音乐经典时刻", showDate: "2026-11-07", sourceType: 2, source: 201713 },
    { id: 500, title: "另一天的故事", tag: "耳虫热单", showDate: "2026-06-01", sourceType: 2, source: 201713 },
  ];
  const { mod } = await loadPlugin({
    handler: api({ "service/musicCalendar/list/history": ok({ list: days }) }),
  });
  const page = await mod.browse({ page: "calendar" });
  const ids = page.sections[0].playlists.map((card) => card.id);
  assert.equal(new Set(ids).size, 2, "the song alone would make them one page");
});

test("a calendar card opens the song of the day", async () => {
  const days = [{
    id: 717,
    title: "隔着多远，都还想见一面",
    pic: "http://img.example/story.jpg",
    tag: "音乐经典时刻",
    showDate: "2026-11-06",
    sourceType: 2,
    source: 6307329,
  }];
  const { mod, calls, storage } = await loadPlugin({
    handler: api({
      "service/musicCalendar/list/history": ok({ list: days }),
      "service/music/info": ok(track({ id: 6307329, name: "多远都要在一起" })),
    }),
  });
  const page = await mod.browse({ page: "calendar" });
  const opened = await mod.playlist({ id: page.sections[0].playlists[0].id });
  assert.equal(opened.id, "cal-717-6307329");
  assert.equal(opened.name, "隔着多远，都还想见一面", "the story the card showed");
  assert.equal(opened.imageUrl, "http://img.example/story.jpg");
  assert.equal(opened.description, "音乐经典时刻 · 2026-11-06");
  assert.equal(opened.tracks.length, 1);
  assert.equal(opened.tracks[0].id, "6307329");
  assert.equal(
    calls.find((call) => call.url.pathname.endsWith("/service/music/info")).url.searchParams.get("musicId"),
    "6307329",
    "the song, not the day's story id",
  );
  assert.equal(opened.mine, true, "a calendar entry is not a collectable playlist");
  assert.ok(storage.get("calendarStories")["cal-717-6307329"], "the story is kept for the next run");
});

test("a calendar story is kept for the next run", async () => {
  const { mod } = await loadPlugin({
    storage: {
      calendarStories: {
        "cal-717-6307329": {
          name: "隔着多远，都还想见一面",
          imageUrl: "http://img.example/story.jpg",
          description: "音乐经典时刻 · 2026-11-06",
        },
      },
    },
    handler: api({ "service/music/info": ok(track({ id: 6307329, name: "多远都要在一起" })) }),
  });
  const opened = await mod.playlist({ id: "cal-717-6307329" });
  assert.equal(opened.name, "隔着多远，都还想见一面");
  assert.equal(opened.imageUrl, "http://img.example/story.jpg");
});

test("a calendar song opened without its card still has a name", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({ "service/music/info": ok(track({ id: 6307329, name: "多远都要在一起" })) }),
  });
  const opened = await mod.playlist({ id: "cal-717-6307329" });
  assert.equal(opened.name, "多远都要在一起");
  assert.equal(opened.imageUrl, "http://img.example/cover.jpg");
  assert.equal(opened.tracks.length, 1);
  assert.equal(calls[0].url.searchParams.get("musicId"), "6307329");
});

test("a calendar song with no info can't be played", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/music/info": ok({}) }),
  });
  await assert.rejects(() => mod.playlist({ id: "cal-1-825441" }), /can’t play this song/);
});

test("a calendar song Bodian took down can't be played", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/music/info": { code: 20012, msg: "歌曲已下线", data: {} } }),
  });
  await assert.rejects(() => mod.playlist({ id: "cal-1-825441" }), /can’t play this song/);
});

test("an empty calendar says so", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/musicCalendar/list/history": ok({ list: [] }) }),
  });
  const page = await mod.browse({ page: "calendar" });
  assert.equal(page.sections[0].empty, "No calendar entries yet");
  assert.ok(!page.sections.some((section) => section.title === "More"));
});

test("the artists page shows the artists Bodian picked", async () => {
  const { mod, calls } = await loadPlugin({
    handler: api({
      "service/finds/module": ok({
        moduleName: "歌手",
        artistList: [
          { id: 5371, name: "G.E.M.邓紫棋", pic: "http://img.example/a.jpg", firstLine: "Ta最近很火" },
          { id: 336, name: "周杰伦", pic: "" },
          { id: 5372 },
          { id: 0, name: "没有 id 的歌手" },
        ],
      }),
    }),
  });
  const page = await mod.browse({ page: "artists" });
  assert.equal(page.title, "Artists");
  const asked = calls[0].url.searchParams;
  assert.equal(asked.get("moduleId"), "54");
  assert.equal(asked.get("categoryId"), "1");
  const artists = page.sections[0].artists;
  assert.deepEqual(artists.map((artist) => artist.id), ["ar-5371", "ar-336"]);
  assert.equal(artists[0].name, "G.E.M.邓紫棋");
  assert.equal(artists[0].imageUrl, "http://img.example/a.jpg");
});

test("the artists page also lists what their listeners listen to", async () => {
  const { mod } = await loadPlugin({
    handler: api({
      "service/finds/module": ok({
        artistList: [{ id: 1, name: "甲" }, { id: 2, name: "乙" }],
      }),
      "service/artist/similar/1": ok({
        resultList: [{ id: 3, name: "丙" }, { id: 2, name: "乙" }, { id: 0 }],
      }),
      "service/artist/similar/2": ok({
        resultList: [{ id: 3, name: "丙" }, { id: 4, name: "丁" }, { id: 5 }],
      }),
    }),
  });
  const page = await mod.browse({ page: "artists" });
  assert.deepEqual(page.sections[0].artists.map((artist) => artist.id), ["ar-1", "ar-2"]);
  const similar = page.sections.find((section) => section.title === "Artists You May Like");
  assert.deepEqual(similar.artists.map((artist) => artist.id), ["ar-3", "ar-4"],
    "no pick is repeated, no artist twice");
});

test("an empty artists page says so", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/finds/module": ok({ artistList: [] }) }),
  });
  const page = await mod.browse({ page: "artists" });
  assert.equal(page.sections[0].empty, "No artists to show yet");
});

test("an empty calendar page has nothing to page to", async () => {
  const { mod } = await loadPlugin({
    handler: api({ "service/musicCalendar/list/history": ok({ list: [] }) }),
  });
  const page = await mod.browse({ page: "calendar-3" });
  // Past the first page the calendar is not empty, so it doesn't say so.
  assert.equal(page.sections[0].empty, "");
  const more = page.sections.find((section) => section.title === "More");
  assert.ok(more.links.some((link) => link.page === "calendar-2"), "the way back is kept");
});