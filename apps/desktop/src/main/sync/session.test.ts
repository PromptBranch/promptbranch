import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { openMemoryDatabase, PromptLibrary, SyncEngine } from "@promptbranch/core";
import { MAX_FRAME_BYTES, createFrameReader, encodeFrame } from "./frames.js";
import { attachSession, SyncSession } from "./session.js";

describe("frames", () => {
  it("round-trips a message", () => {
    const frames: unknown[] = [];
    const read = createFrameReader((message) => frames.push(message));
    read(encodeFrame({ t: "ping" }));
    expect(frames).toEqual([{ t: "ping" }]);
  });

  it("reassembles messages split across arbitrary chunk boundaries", () => {
    const frames: unknown[] = [];
    const read = createFrameReader((message) => frames.push(message));
    const first = encodeFrame({ t: "ping" });
    const second = encodeFrame({ t: "pong" });
    const combined = Buffer.concat([first, second]);
    // Feed one byte at a time — worst-case fragmentation.
    for (let i = 0; i < combined.length; i++) {
      read(Buffer.from(combined.subarray(i, i + 1)));
    }
    expect(frames).toEqual([{ t: "ping" }, { t: "pong" }]);
  });

  it("rejects oversized frames", () => {
    const read = createFrameReader(() => undefined);
    expect(() => read(encodeFrame({ t: "x", pad: "y".repeat(MAX_FRAME_BYTES) }))).toThrow(/too large/i);
  });
});

/** Cross-connected in-memory socket pair. */
function streamPair(): [Duplex, Duplex] {
  let a!: Duplex;
  let b!: Duplex;
  a = new Duplex({
    write(chunk, _enc, cb) {
      b.push(chunk as Buffer);
      cb();
    },
    read() {},
  });
  b = new Duplex({
    write(chunk, _enc, cb) {
      a.push(chunk as Buffer);
      cb();
    },
    read() {},
  });
  return [a, b];
}

interface Rig {
  db: ReturnType<typeof openMemoryDatabase>;
  lib: PromptLibrary;
  engine: SyncEngine;
}

function rig(): Rig {
  const db = openMemoryDatabase();
  return { db, lib: new PromptLibrary(db), engine: new SyncEngine(db) };
}

function sessionPair(a: Rig, b: Rig, byteBudget?: number): [SyncSession, SyncSession] {
  const [socketA, socketB] = streamPair();
  const sessionA = new SyncSession(socketA, {
    engine: a.engine,
    deviceName: "Device A",
    byteBudget,
  });
  const sessionB = new SyncSession(socketB, {
    engine: b.engine,
    deviceName: "Device B",
    byteBudget,
  });
  attachSession(socketA, sessionA);
  attachSession(socketB, sessionB);
  sessionA.start();
  sessionB.start();
  return [sessionA, sessionB];
}

describe("sync session", () => {
  it("fails the session immediately when a peer uses an incompatible protocol", () => {
    const local = rig();
    const [socket] = streamPair();
    socket.on("error", () => undefined);
    const log = vi.fn();
    const session = new SyncSession(socket, {
      engine: local.engine,
      deviceName: "Current device",
      log,
    });

    session.handleMessageFrame({
      t: "hello",
      v: 1,
      deviceId: "old-device",
      name: "Old device",
      cursors: {},
    });

    expect(session.currentState).toBe("error");
    expect(socket.destroyed).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/protocol version 1/i));
    local.db.close();
  });

  it("converges both directions over an in-memory stream pair", async () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Over the wire", content: "v1" });
    a.lib.createTag({ name: "wire" });
    a.engine.refineDirty();
    const promptB = b.lib.createPrompt({ title: "From B", content: "b1" });
    b.engine.refineDirty();

    const [sessionA, sessionB] = sessionPair(a, b);
    await vi.waitFor(() => expect(sessionA.currentState).toBe("steady"));
    await vi.waitFor(() => expect(sessionB.currentState).toBe("steady"));

    expect(b.lib.getPrompt(prompt.id)?.title).toBe("Over the wire");
    expect(a.lib.getPrompt(promptB.id)?.title).toBe("From B");
    expect(a.lib.listTags().map((t) => t.name)).toContain("wire");

    sessionA.close();
    sessionB.close();
  });

  it("propagates writes made after the session went steady", async () => {
    const a = rig();
    const b = rig();
    a.lib.createPrompt({ title: "Initial", content: "x" });
    a.engine.refineDirty();
    const [sessionA, sessionB] = sessionPair(a, b);
    await vi.waitFor(() => expect(sessionA.currentState).toBe("steady"));
    await vi.waitFor(() => expect(sessionB.currentState).toBe("steady"));

    const note = { promptId: a.lib.listPrompts()[0]!.id, body: "late note" };
    a.lib.addNote(note);
    a.engine.refineDirty();
    sessionA.notify();

    await vi.waitFor(() => expect(b.lib.listNotes(note.promptId).length).toBe(1));
    sessionA.close();
    sessionB.close();
  });

  it("converges across a tiny frame budget", async () => {
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Big", content: "x".repeat(4_000) });
    a.lib.addNote({ promptId: prompt.id, body: "note" });
    a.engine.refineDirty();

    const [sessionA, sessionB] = sessionPair(a, b, 512);
    await vi.waitFor(() => expect(sessionA.currentState).toBe("steady"));
    await vi.waitFor(() => expect(sessionB.currentState).toBe("steady"));

    expect(b.lib.getPrompt(prompt.id)).not.toBeNull();
    expect(b.lib.listNotes(prompt.id).length).toBe(1);
    sessionA.close();
    sessionB.close();
  });

  it("converges when tiny junctions exceed the per-frame op cap", async () => {
    // 4,600 junction ops fit well under the 1 MB byte budget but exceed the
    // protocol's 5,000-op frame limit — the exact scenario where an uncapped
    // serve() emitted a frame the receiver silently dropped, forever.
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Flood", content: "x" });
    const tags = Array.from({ length: 4_600 }, (_, i) =>
      a.db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").run(crypto.randomUUID(), `tag-${i}`),
    );
    void tags;
    for (const tag of a.lib.listTags()) {
      a.db.prepare("INSERT OR IGNORE INTO prompt_tags (prompt_id, tag_id) VALUES (?, ?)").run(
        prompt.id,
        tag.id,
      );
    }
    a.engine.refineDirty();
    expect(a.engine.opsSince({}, 10_000_000).ops.length).toBeGreaterThan(4_500);

    const [sessionA, sessionB] = sessionPair(a, b);
    await vi.waitFor(() => expect(sessionA.currentState).toBe("steady"), { timeout: 15_000 });
    await vi.waitFor(() => expect(sessionB.currentState).toBe("steady"), { timeout: 15_000 });

    expect(b.lib.listTagsForPrompt(prompt.id).length).toBe(4_600);
    sessionA.close();
    sessionB.close();
  }, 20_000);
});
