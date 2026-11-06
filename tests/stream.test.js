import test from "node:test";
import assert from "node:assert/strict";

import { api, loadPlugin, ok } from "./harness.js";

// audio answers the bit rates a song is asked for, as Bodian does: each br
// maps to the format and bitrate it comes back as.
function audio(byBitrate) {
  return api({
    "play/music/v2/audioUrl": (url) => {
      const br = Number(url.searchParams.get("br"));
      const answer = byBitrate[br];
      if (!answer) return { code: 20018, msg: "没有解锁付费歌曲", data: {} };
      return ok({
        audioUrl: `https://bd-er.kuwo.cn/${br}.${answer.format}`,
        audioHttpsUrl: `https://bd-er.kuwo.cn/${br}.${answer.format}`,
        format: answer.format,
        bitrate: answer.bitrate,
        size: answer.size || "10.00Mb",
      });
    },
  });
}

test("lossless asks for the FLAC first", async () => {
  const { mod, calls } = await loadPlugin({
    handler: audio({ 2000: { format: "flac", bitrate: 2000, size: "23.21Mb" } }),
  });
  const stream = await mod.stream({ id: "1", quality: "lossless" });
  assert.equal(stream.type, "flac");
  assert.equal(stream.quality, "lossless");
  assert.equal(stream.size, Math.round(23.21 * 1024 * 1024));
  assert.equal(calls[0].url.searchParams.get("br"), "2000");
});

test("high takes the FLAC where the song has one", async () => {
  const { mod } = await loadPlugin({
    handler: audio({ 20000: { format: "flac", bitrate: 2000 } }),
  });
  const stream = await mod.stream({ id: "1", quality: "high" });
  assert.equal(stream.type, "flac");
  assert.equal(stream.quality, "lossless");
});

test("high takes the 320 kbps MP3 where the song has no FLAC", async () => {
  const { mod, calls } = await loadPlugin({
    handler: audio({ 20000: { format: "mp3", bitrate: 320 } }),
  });
  const stream = await mod.stream({ id: "1", quality: "high" });
  assert.equal(stream.type, "mp3");
  assert.equal(stream.quality, "high");
  assert.equal(stream.bitRate, 320);
  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get("br")),
    ["20000"],
  );
});

test("high takes a 128 kbps MP3 when that is all there is", async () => {
  const { mod, calls } = await loadPlugin({
    handler: audio({
      20000: { format: "mp3", bitrate: 128 },
      320: { format: "mp3", bitrate: 128 },
      128: { format: "mp3", bitrate: 128 },
    }),
  });
  const stream = await mod.stream({ id: "1", quality: "high" });
  assert.equal(stream.quality, "standard");
  assert.equal(stream.bitRate, 128);
  assert.equal(calls.length, 3);
});

test("standard asks only for 128", async () => {
  const { mod, calls } = await loadPlugin({
    handler: audio({ 128: { format: "mp3", bitrate: 128 } }),
  });
  await mod.stream({ id: "1", quality: "standard" });
  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get("br")),
    ["128"],
  );
});

test("a song with no stream at all is unavailable", async () => {
  const { mod } = await loadPlugin({ handler: audio({}) });
  await assert.rejects(
    () => mod.stream({ id: "1", quality: "high" }),
    (error) => error.code === "unavailable",
  );
});

test("an encrypted or unknown format is never handed to the player", async () => {
  const { mod, calls } = await loadPlugin({
    handler: audio({ 20000: { format: "mflac", bitrate: 2000 }, 320: { format: "mp3", bitrate: 128 } }),
  });
  const stream = await mod.stream({ id: "1", quality: "high" });
  assert.equal(stream.type, "mp3");
  // The encrypted stream is passed over, and the ladder carries on to 128.
  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get("br")),
    ["20000", "320", "128"],
  );
});
