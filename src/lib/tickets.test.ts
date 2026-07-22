import { describe, expect, it } from "vitest";
import { MemoryTextStore } from "./opfs-kv";
import {
  createTicketToolExecutor,
  parseTickets,
  serializeTickets,
  sortTickets,
  TICKET_LIMITS,
  TicketBoard,
  type Ticket
} from "./tickets";

function boardWithClock(store = new MemoryTextStore()) {
  let tick = 0;
  const board = new TicketBoard(store, () => new Date(2026, 6, 22, 12, 0, tick++));
  return { board, store };
}

describe("ticket board", () => {
  it("creates tickets and orders the queue doing → todo (oldest first) → blocked → done (newest first)", async () => {
    const { board } = boardWithClock();
    const first = await board.create({ title: "First chore", createdBy: "user" });
    const second = await board.create({ title: "Second chore", createdBy: "user" });
    const active = await board.create({ title: "Active", createdBy: "user" });
    const blocked = await board.create({ title: "Stuck", createdBy: "user" });
    const oldDone = await board.create({ title: "Old done", createdBy: "user" });
    const newDone = await board.create({ title: "New done", createdBy: "user" });
    await board.claim(active.id, "h-worker");
    await board.update(blocked.id, { status: "blocked", note: "waiting on input" });
    await board.update(oldDone.id, { status: "done" });
    await board.update(newDone.id, { status: "done" });
    const ids = board.list().map((ticket) => ticket.id);
    expect(ids).toEqual([active.id, first.id, second.id, blocked.id, newDone.id, oldDone.id]);
  });

  it("gives concurrent claimers one winner and one final error", async () => {
    const { board } = boardWithClock();
    const ticket = await board.create({ title: "Contested", createdBy: "user" });
    const results = await Promise.allSettled([
      board.claim(ticket.id, "h-first1"),
      board.claim(ticket.id, "h-second")
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already claimed/);
    // Re-claiming your own ticket stays fine (idempotent).
    const winner = (fulfilled[0] as PromiseFulfilledResult<Ticket>).value.assignee!;
    await expect(board.claim(ticket.id, winner)).resolves.toMatchObject({ assignee: winner });
  });

  it("persists every mutation so a fresh board over the same store sees the state", async () => {
    const { board, store } = boardWithClock();
    const ticket = await board.create({ title: "Durable", createdBy: "h-maker1" });
    await board.update(ticket.id, { status: "done", note: "did it" });
    const fresh = new TicketBoard(store);
    await fresh.ready();
    expect(fresh.list()).toMatchObject([{ id: ticket.id, status: "done", note: "did it", createdBy: "h-maker1" }]);
  });

  it("survives concurrent creates without losing tickets", async () => {
    const { board, store } = boardWithClock();
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      board.create({ title: `Ticket ${index}`, createdBy: "user" })
    ));
    const fresh = new TicketBoard(store);
    await fresh.ready();
    expect(fresh.list()).toHaveLength(20);
  });

  it("enforces the board cap and title requirements", async () => {
    const { board } = boardWithClock();
    for (let index = 0; index < TICKET_LIMITS.maxTickets; index += 1) {
      await board.create({ title: `T${index}`, createdBy: "user" });
    }
    await expect(board.create({ title: "One too many", createdBy: "user" })).rejects.toThrow(/full/);
    await expect(board.update(board.list()[0].id, { title: "   " })).rejects.toThrow(/non-empty title/);
  });

  it("round-trips through serialize and parse, dropping malformed entries", () => {
    const good: Ticket = {
      id: "t-abc123",
      title: "Real",
      detail: "",
      status: "todo",
      assignee: null,
      createdBy: "user",
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
      note: ""
    };
    const raw = JSON.stringify({
      schemaVersion: 1,
      tickets: [good, { id: "bad id" }, { id: "t-noname" }, { ...good, id: "t-abc123" }, 42]
    });
    expect(parseTickets(raw)).toEqual([good]);
    expect(parseTickets(serializeTickets([good]))).toEqual([good]);
    expect(parseTickets("{broken")).toBeNull();
    expect(parseTickets(JSON.stringify({ schemaVersion: 9, tickets: [] }))).toBeNull();
  });

  it("keeps sortTickets pure", () => {
    const tickets = parseTickets(serializeTickets([]))!;
    expect(sortTickets(tickets)).toEqual([]);
  });
});

describe("ticket tools", () => {
  it("lists open and recently done tickets with the caller's identity", async () => {
    const { board } = boardWithClock();
    const execute = createTicketToolExecutor(board, "h-lister");
    await board.create({ title: "Open one", createdBy: "user" });
    const done = await board.create({ title: "Done one", createdBy: "user" });
    await board.update(done.id, { status: "done" });
    const outcome = await execute("list_tickets", {}, {});
    expect(outcome.isError).toBeFalsy();
    const parsed = JSON.parse(outcome.content) as {
      you_are: string;
      open: Array<{ title: string }>;
      recently_done: Array<{ title: string }>;
    };
    expect(parsed.you_are).toBe("h-lister");
    expect(parsed.open.map((ticket) => ticket.title)).toEqual(["Open one"]);
    expect(parsed.recently_done.map((ticket) => ticket.title)).toEqual(["Done one"]);
  });

  it("creates tickets attributed to the calling hatchling", async () => {
    const { board } = boardWithClock();
    const execute = createTicketToolExecutor(board, "h-maker1");
    const outcome = await execute("create_ticket", { title: "From agent", detail: "notes" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(board.list()[0]).toMatchObject({ title: "From agent", createdBy: "h-maker1", status: "todo" });
  });

  it("claims, updates, and surfaces conflicts as tool errors instead of throws", async () => {
    const { board } = boardWithClock();
    const mine = createTicketToolExecutor(board, "h-mine11");
    const theirs = createTicketToolExecutor(board, "h-theirs");
    const ticket = await board.create({ title: "Contested", createdBy: "user" });

    const claimed = await mine("update_ticket", { id: ticket.id, claim: true }, {});
    expect(claimed.isError).toBeFalsy();
    expect(JSON.parse(claimed.content).updated).toMatchObject({ status: "doing", assignee: "h-mine11" });

    const refused = await theirs("update_ticket", { id: ticket.id, claim: true }, {});
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/already claimed/);

    const finished = await mine("update_ticket", { id: ticket.id, status: "done", note: "shipped" }, {});
    expect(finished.isError).toBeFalsy();
    expect(board.list()[0]).toMatchObject({ status: "done", note: "shipped" });
  });

  it("validates arguments without touching the board", async () => {
    const { board } = boardWithClock();
    const execute = createTicketToolExecutor(board, "h-check1");
    expect((await execute("create_ticket", { title: "  " }, {})).isError).toBe(true);
    expect((await execute("update_ticket", { id: "t-none99" }, {})).isError).toBe(true);
    expect((await execute("update_ticket", { id: "t-none99", status: "bogus" }, {})).isError).toBe(true);
    expect((await execute("nonexistent_tool", {}, {})).isError).toBe(true);
    await board.ready();
    expect(board.list()).toHaveLength(0);
  });
});
