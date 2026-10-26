import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createBot, type BotRow } from "../src/db";
import { pruneOutboundQuota } from "../src/inbound-security";
import { createDraft, sendExistingDraft, submitOutbound } from "../src/outbound";

const DAY_N = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

function emailBinding(): { send: (message: unknown) => Promise<{ messageId: string }> } {
  return env.EMAIL as { send: (message: unknown) => Promise<{ messageId: string }> };
}

async function oldDraft(bot: BotRow, subject: string): Promise<string> {
  const draft = await createDraft(env, bot, {
    to: ["athena@bots.example.test"],
    subject,
    text: "quota",
  });
  await env.DB.prepare(`UPDATE messages SET created_at = ? WHERE id = ?`).bind(DAY_N, draft.message_id).run();
  return draft.message_id;
}

describe("outbound quota", () => {
  it("rejects an old draft once today's stamp quota is already spent", async () => {
    const mutable = env as { OUTBOUND_DAILY_STAMP_LIMIT?: string };
    const previous = mutable.OUTBOUND_DAILY_STAMP_LIMIT;
    mutable.OUTBOUND_DAILY_STAMP_LIMIT = "1";
    const email = emailBinding();
    const original = email.send;
    let sends = 0;
    email.send = async () => {
      sends += 1;
      return { messageId: `<quota-${crypto.randomUUID()}@bots.example.test>` };
    };
    try {
      const { bot } = await createBot(env, { id: "stamper", local: "stamper", displayName: "Stamper" });
      const firstId = await oldDraft(bot, "Yesterday");
      const first = await sendExistingDraft(env, bot, firstId, "bot");
      expect(first.status).toBe("sent");
      const spent = await env.DB.prepare(`SELECT created_at, status FROM messages WHERE id = ?`)
        .bind(firstId)
        .first<{ created_at: string; status: string }>();
      expect(spent).toEqual({ created_at: DAY_N, status: "sent" });

      const secondId = await oldDraft(bot, "Yesterday again");
      const second = await sendExistingDraft(env, bot, secondId, "bot");
      expect(second.status).toBe("failed");
      expect(second.error).toContain("Daily stamp limit");
      expect(sends).toBe(1);
      const kept = await env.DB.prepare(`SELECT id, status, created_at FROM messages WHERE id = ?`)
        .bind(secondId)
        .first<{ id: string; status: string; created_at: string }>();
      expect(kept).toEqual({ id: secondId, status: "failed", created_at: DAY_N });
      const charged = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM outbound_quota WHERE bot_id = ? AND kind = 'stamp' AND status = 'charged'`,
      )
        .bind(bot.id)
        .first<{ n: number }>();
      expect(Number(charged?.n)).toBe(1);
    } finally {
      email.send = original;
      mutable.OUTBOUND_DAILY_STAMP_LIMIT = previous;
    }
  });

  it("lets one of two concurrent sends through when one stamp slot is left", async () => {
    const mutable = env as { OUTBOUND_DAILY_STAMP_LIMIT?: string };
    const previous = mutable.OUTBOUND_DAILY_STAMP_LIMIT;
    mutable.OUTBOUND_DAILY_STAMP_LIMIT = "2";
    const email = emailBinding();
    const original = email.send;
    let sends = 0;
    email.send = async () => {
      sends += 1;
      return { messageId: `<race-${crypto.randomUUID()}@bots.example.test>` };
    };
    try {
      const { bot } = await createBot(env, { id: "racer", local: "racer", displayName: "Racer" });
      const prime = await submitOutbound(
        env,
        bot,
        { to: ["athena@bots.example.test"], subject: "Prime", text: "one" },
        "bot",
      );
      expect(prime.status).toBe("sent");
      const pair = await Promise.all([
        submitOutbound(env, bot, { to: ["athena@bots.example.test"], subject: "Race A", text: "a" }, "bot"),
        submitOutbound(env, bot, { to: ["athena@bots.example.test"], subject: "Race B", text: "b" }, "bot"),
      ]);
      const sent = pair.filter((result) => result.status === "sent");
      const denied = pair.filter((result) => result.status === "failed");
      expect(sent).toHaveLength(1);
      expect(denied).toHaveLength(1);
      expect(denied[0]?.error).toContain("Daily stamp limit");
      expect(sends).toBe(2);
    } finally {
      email.send = original;
      mutable.OUTBOUND_DAILY_STAMP_LIMIT = previous;
    }
  });

  it("reserves one automated reply and rejects the next at the limit", async () => {
    const mutable = env as { INBOUND_AUTO_REPLY_LIMIT?: string };
    const previous = mutable.INBOUND_AUTO_REPLY_LIMIT;
    mutable.INBOUND_AUTO_REPLY_LIMIT = "1";
    const email = emailBinding();
    const original = email.send;
    let sends = 0;
    email.send = async () => {
      sends += 1;
      return { messageId: `<reply-${crypto.randomUUID()}@bots.example.test>` };
    };
    try {
      const { bot } = await createBot(env, { id: "replier", local: "replier", displayName: "Replier" });
      const first = await submitOutbound(
        env,
        bot,
        { to: ["athena@bots.example.test"], subject: "Reply once", text: "one" },
        "bot",
      );
      expect(first.status).toBe("sent");
      const second = await submitOutbound(
        env,
        bot,
        { to: ["athena@bots.example.test"], subject: "Reply twice", text: "two" },
        "bot",
      );
      expect(second.status).toBe("failed");
      expect(second.error).toContain("Auto-reply loop");
      expect(sends).toBe(1);
      const charged = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM outbound_quota WHERE bot_id = ? AND kind = 'auto_reply' AND status = 'charged'`,
      )
        .bind(bot.id)
        .first<{ n: number }>();
      expect(Number(charged?.n)).toBe(1);
    } finally {
      email.send = original;
      mutable.INBOUND_AUTO_REPLY_LIMIT = previous;
    }
  });

  it("releases a reservation when EMAIL.send fails", async () => {
    const mutable = env as { OUTBOUND_DAILY_STAMP_LIMIT?: string };
    const previous = mutable.OUTBOUND_DAILY_STAMP_LIMIT;
    mutable.OUTBOUND_DAILY_STAMP_LIMIT = "1";
    const email = emailBinding();
    const original = email.send;
    email.send = async () => {
      throw new Error("smtp down");
    };
    try {
      const { bot } = await createBot(env, { id: "releaser", local: "releaser", displayName: "Releaser" });
      const failed = await submitOutbound(
        env,
        bot,
        { to: ["athena@bots.example.test"], subject: "Did not leave", text: "nope" },
        "bot",
      );
      expect(failed.status).toBe("failed");
      const held = await env.DB.prepare(`SELECT status FROM outbound_quota WHERE bot_id = ?`).bind(bot.id).all<{ status: string }>();
      expect(held.results.length).toBeGreaterThan(0);
      expect(held.results.every((row) => row.status === "released")).toBe(true);

      email.send = async () => ({ messageId: `<released-${crypto.randomUUID()}@bots.example.test>` });
      const next = await submitOutbound(
        env,
        bot,
        { to: ["athena@bots.example.test"], subject: "After release", text: "yes" },
        "bot",
      );
      expect(next.status).toBe("sent");
    } finally {
      email.send = original;
      mutable.OUTBOUND_DAILY_STAMP_LIMIT = previous;
    }
  });

  it("deletes quota rows older than the retention window", async () => {
    const stale = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    const inside = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const insert = `INSERT INTO outbound_quota (id, bot_id, attempt_id, kind, recipient, reserved_at, status, created_at, updated_at) VALUES (?, 'prunebot', 'attempt', 'stamp', 'athena@bots.example.test', ?, ?, ?, ?)`;
    await env.DB.prepare(insert).bind("quota-stale-released", stale, "released", stale, stale).run();
    await env.DB.prepare(insert).bind("quota-stale-charged", stale, "charged", stale, stale).run();
    await env.DB.prepare(insert).bind("quota-inside", inside, "charged", inside, inside).run();
    await env.DB.prepare(insert).bind("quota-fresh", fresh, "charged", fresh, fresh).run();
    const removed = await pruneOutboundQuota(env);
    expect(removed).toBeGreaterThanOrEqual(2);
    const left = await env.DB.prepare(`SELECT id FROM outbound_quota WHERE bot_id = 'prunebot'`).all<{ id: string }>();
    expect(left.results.map((row) => row.id).sort()).toEqual(["quota-fresh", "quota-inside"]);
  });
});
