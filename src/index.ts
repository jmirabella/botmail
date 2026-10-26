import { ensureDomains } from "./domains";
import { processInboundEmail } from "./inbound";
import { pruneOutboundQuota } from "./inbound-security";
import { logError } from "./log";
import { oauthProvider } from "./oauth";
import { drainWebhooks } from "./webhook";

export default {
  async fetch(request, env, ctx) {
    return oauthProvider(env).fetch(request, env, ctx);
  },

  async email(message, env) {
    try {
      await processInboundEmail(
        {
          from: message.from,
          to: message.to,
          headers: message.headers,
          raw: message.raw,
          rawSize: message.rawSize,
          setReject(reason) {
            message.setReject(reason);
          },
          forward: message.forward
            ? async (rcpt) => {
                await message.forward(rcpt);
              }
            : undefined,
        },
        env,
      );
    } catch (error) {
      logError("inbound_failed", {
        error: error instanceof Error ? error.message : "inbound failed",
        to: message.to,
      });
      throw error;
    }
  },

  async scheduled(_controller, env) {
    try {
      await ensureDomains(env);
      await drainWebhooks(env);
    } catch (error) {
      logError("webhook_drain_failed", {
        error: error instanceof Error ? error.message : "drain failed",
      });
    }
    try {
      await pruneOutboundQuota(env);
    } catch (error) {
      logError("quota_prune_failed", {
        error: error instanceof Error ? error.message : "quota prune failed",
      });
    }
    try {
      await oauthProvider(env).purgeExpiredData(env);
    } catch (error) {
      logError("oauth_purge_failed", {
        error: error instanceof Error ? error.message : "oauth purge failed",
      });
    }
  },
} satisfies ExportedHandler<Env>;
