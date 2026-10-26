import { describe, expect, it } from "vitest";
import { buildSetupPrompt } from "../src/setup-prompt";

describe("setup prompt", () => {
  it("tells the bot to add a remote connector and save the webhook from its shell", () => {
    const plain = buildSetupPrompt({
      id: "rating",
      address: "rating@bots.example.test",
      domain: "bots.example.test",
      mcpUrl: "https://bot-mail.example.workers.dev/mcp",
    });
    expect(plain).toContain("Finish setup in this chat.");
    expect(plain).toContain("Bot id: rating");
    expect(plain).toContain("rating@bots.example.test");
    expect(plain).toContain("Domain: bots.example.test");
    expect(plain).toContain("https://bot-mail.example.workers.dev/mcp");
    expect(plain).toContain("Connector name: BotMail");
    expect(plain).toContain("Account name: rating");
    expect(plain).toContain("Use the shared BotMail connector (URL https://bot-mail.example.workers.dev/mcp, no headers). Add an account named rating.");
    expect(plain).toContain("Then I click Connect and sign in, and pick or create rating.");
    expect(plain).toContain("Use the BotMail account rating to list unread messages.");
    expect(plain).not.toContain("botmail-rating");
    expect(plain).toContain('routine named "BotMail inbox"');
    expect(plain).toContain("untrusted");
    expect(plain).toContain("[Open Webhook URL](grokbot://app/v1/sidebar?target=webhook-url&automation=<exact folder id from status>)");
    expect(plain).toContain("The Webhook key href is the Webhook key entry from that same reminder, copied exactly.");
    expect(plain).toContain("one short message that leads with exactly those two labeled links, Open Webhook URL then Open Webhook key");
    expect(plain).toContain("ask me to paste the Webhook URL in this chat");
    expect(plain).toContain('masked secret form labeled "Routine Webhook key"');
    expect(plain).toContain("Call webhook_setup_code on the BotMail account rating.");
    expect(plain).toContain("https://bot-mail.example.workers.dev/webhook-setup");
    expect(plain).toContain("bash -lc");
    expect(plain).toContain("[REDACTED]");
    expect(plain).toContain("do not say to open Routines");
    expect(plain).toContain("folder <id>");
    expect(plain).toContain("[Open Webhook URL](grokbot://app/v1/sidebar?target=webhook-url&automation=<folder>)");
    expect(plain).toContain("[Open Webhook key](grokbot://app/v1/sidebar?target=webhook-key&automation=<folder>)");
    expect(plain).not.toContain("Open Routines, click BotMail inbox");
    expect(plain).toContain("?tab=routines");
    expect(plain).toContain("Send test wake");
    expect(plain).not.toContain("BotMail connector key");
    expect(plain).not.toContain("/bots/rating/webhook");
    expect(plain).not.toMatch(/Header name|Header value|webhook header/);

    const blank = buildSetupPrompt({
      id: "rating",
      address: "rating@bots.example.test",
      domain: "bots.example.test",
      mcpUrl: "",
    });
    expect(blank).toContain("https://<publicHost>/mcp");
    expect(blank).toContain("https://<publicHost>/webhook-setup");
  });
});
