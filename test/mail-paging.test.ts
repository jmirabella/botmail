import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { adminRequest } from "./helpers";

type Page = { messages: Array<{ id: string }>; next_cursor: string | null };

async function insertMail(row: { id: string; messageDate: string | null; createdAt: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
      id, bot_id, direction, folder, status, from_addr, to_addrs, subject, message_date, created_at, updated_at
    ) VALUES (?, 'pager', 'in', 'inbox', 'received', 'ada@example.test', '["pager@bots.example.test"]', ?, ?, ?, ?)`,
  )
    .bind(row.id, row.id, row.messageDate, row.createdAt, row.createdAt)
    .run();
}

async function pages(limit: number): Promise<{ pages: string[][]; cursors: Array<string | null> }> {
  const collected: string[][] = [];
  const cursors: Array<string | null> = [];
  let cursor: string | null = null;
  for (let hop = 0; hop < 8; hop++) {
    const params = new URLSearchParams({ bot: "pager", limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const response = await worker.fetch(await adminRequest(`/admin/api/mail?${params}`), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Page;
    collected.push(body.messages.map((row) => row.id));
    cursors.push(body.next_cursor);
    if (!body.next_cursor) return { pages: collected, cursors };
    cursor = body.next_cursor;
  }
  throw new Error("paging did not end");
}

afterEach(async () => {
  await env.DB.prepare(`DELETE FROM messages WHERE bot_id = ?`).bind("pager").run();
});

describe("inbox cursor paging", () => {
  it("pages across a timestamp tie without gaps or duplicates", async () => {
    const older = "2026-01-01T00:00:00.000Z";
    await insertMail({ id: "page-a", messageDate: "2026-04-02T00:00:00.000Z", createdAt: older });
    await insertMail({ id: "page-b", messageDate: "2026-04-02T00:00:00.000Z", createdAt: older });
    await insertMail({ id: "page-c", messageDate: "2026-04-03T00:00:00.000Z", createdAt: older });
    await insertMail({ id: "page-d", messageDate: "2026-04-01T00:00:00.000Z", createdAt: older });
    await insertMail({ id: "page-e", messageDate: null, createdAt: "2026-04-01T00:00:00.000Z" });

    const listed = await pages(2);
    expect(listed.pages).toEqual([["page-c", "page-b"], ["page-a", "page-e"], ["page-d"]]);
    expect(listed.cursors[2]).toBeNull();
    const ids = listed.pages.flat();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns a null cursor when the last page is full", async () => {
    for (const id of ["page-1", "page-2", "page-3", "page-4"]) {
      await insertMail({ id, messageDate: `2026-05-0${id.slice(-1)}T00:00:00.000Z`, createdAt: "2026-01-01T00:00:00.000Z" });
    }
    const listed = await pages(2);
    expect(listed.pages).toEqual([
      ["page-4", "page-3"],
      ["page-2", "page-1"],
    ]);
    expect(listed.cursors).toEqual([expect.any(String), null]);
  });
});
