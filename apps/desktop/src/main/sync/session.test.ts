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
  it("fails an incompatible hello without mutating remote sync state", () => {
    const local = rig();
    const [socket] = streamPair();
    socket.on("error", () => undefined);
    const log = vi.fn();
    const applyRemote = vi.spyOn(local.engine, "applyRemote");
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
    session.handleMessageFrame({
      t: "ops",
      ops: [{
        source: "old-device",
        seq: 1,
        opId: "old-device-1",
        table: "prompts",
        recordId: "remote-prompt",
        kind: "delete",
        payload: null,
        hlc: "0000000000001000:000000:old-device",
        createdAt: "2026-09-12T00:00:00.000Z",
      }],
      more: false,
    });

    expect(session.currentState).toBe("error");
    expect(socket.destroyed).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/received protocol 1, schema missing; expected protocol 4, schema 13/i),
    );
    expect(applyRemote).not.toHaveBeenCalled();
    expect(local.db.prepare("SELECT COUNT(*) AS n FROM sync_ops").get()).toEqual({ n: 0 });
    expect(local.db.prepare("SELECT COUNT(*) AS n FROM sync_heads").get()).toEqual({ n: 0 });
    expect(local.db.prepare("SELECT COUNT(*) AS n FROM sync_cursors").get()).toEqual({ n: 0 });
    local.db.close();
  });

  it("fails closed when ops arrive before a compatible hello", () => {
    const local = rig();
    const [socket] = streamPair();
    socket.on("error", () => undefined);
    const applyRemote = vi.spyOn(local.engine, "applyRemote");
    const session = new SyncSession(socket, {
      engine: local.engine,
      deviceName: "Current device",
    });

    session.handleMessageFrame({ t: "ops", ops: [], more: false });

    expect(session.currentState).toBe("error");
    expect(socket.destroyed).toBe(true);
    expect(applyRemote).not.toHaveBeenCalled();
    local.db.close();
  });

  it("ignores later frames in a chunk after an incompatible hello closes the session", async () => {
    const local = rig();
    const remote = rig();
    const prompt = remote.lib.createPrompt({ title: "Must not apply", content: "remote" });
    remote.engine.refineDirty();
    const { ops } = remote.engine.opsSince({}, 1_000_000);
    const [socket, peerSocket] = streamPair();
    socket.on("error", () => undefined);
    const applyRemote = vi.spyOn(local.engine, "applyRemote");
    const session = new SyncSession(socket, {
      engine: local.engine,
      deviceName: "Current device",
    });
    attachSession(socket, session);

    peerSocket.write(Buffer.concat([
      encodeFrame({
        t: "hello",
        v: 3,
        deviceId: "v0.5.0-device",
        name: "PromptBranch 0.5.0",
        cursors: {},
      }),
      encodeFrame({ t: "ops", ops, more: false }),
    ]));

    await vi.waitFor(() => expect(session.currentState).toBe("error"));
    expect(socket.destroyed).toBe(true);
    expect(applyRemote).not.toHaveBeenCalled();
    expect(local.lib.getPrompt(prompt.id)).toBeNull();
    local.db.close();
    remote.db.close();
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
    // The tags and junctions fit well under the 1 MB byte budget but together
    // exceed the protocol's 5,000-op frame limit — the exact scenario where
    // an uncapped serve() emitted a frame the receiver silently dropped.
    const a = rig();
    const b = rig();
    const prompt = a.lib.createPrompt({ title: "Flood", content: "x" });
    const insertTag = a.db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)");
    const insertPromptTag = a.db.prepare(
      "INSERT INTO prompt_tags (prompt_id, tag_id) VALUES (?, ?)",
    );
    a.db.transaction(() => {
      const tagIds: string[] = [];
      for (let i = 0; i < 2_600; i += 1) {
        const tagId = crypto.randomUUID();
        tagIds.push(tagId);
        insertTag.run(tagId, `tag-${i}`);
      }
      for (const tagId of tagIds) {
        insertPromptTag.run(prompt.id, tagId);
      }
    })();
    a.engine.refineDirty();
    expect(a.engine.opsSince({}, 10_000_000).ops.length).toBeGreaterThan(5_000);

    const historyLoads = { prompt_tags: 0, collection_prompts: 0 };
    const batchLoads: Array<typeof historyLoads> = [];
    const prepare = b.db.prepare.bind(b.db);
    const prepareSpy = vi.spyOn(b.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (/SELECT \* FROM sync_ops\s+WHERE table_name = \?\s*$/.test(sql)) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters: unknown[]) => {
          const table = parameters[0];
          if (table === "prompt_tags" || table === "collection_prompts") historyLoads[table] += 1;
          return all(...parameters);
        });
      }
      return statement;
    });
    const applyRemote = b.engine.applyRemote.bind(b.engine);
    const applySpy = vi.spyOn(b.engine, "applyRemote").mockImplementation((ops) => {
      historyLoads.prompt_tags = 0;
      historyLoads.collection_prompts = 0;
      const result = applyRemote(ops);
      batchLoads.push({ ...historyLoads });
      return result;
    });

    const [sessionA, sessionB] = sessionPair(a, b);
    try {
      await vi.waitFor(() => expect(sessionA.currentState).toBe("steady"), { timeout: 15_000 });
      await vi.waitFor(() => expect(sessionB.currentState).toBe("steady"), { timeout: 15_000 });

      expect(b.lib.listTagsForPrompt(prompt.id).length).toBe(2_600);
      expect(batchLoads.length).toBeGreaterThan(0);
      for (const batch of batchLoads) {
        expect(batch.prompt_tags).toBeLessThanOrEqual(1);
        expect(batch.collection_prompts).toBeLessThanOrEqual(1);
      }
    } finally {
      applySpy.mockRestore();
      prepareSpy.mockRestore();
      sessionA.close();
      sessionB.close();
      a.db.close();
      b.db.close();
    }
  }, 20_000);
});
