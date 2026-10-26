export type AddressKind = "mailbox" | "alias" | "forward";

export type AddressOwner = {
  address: string;
  kind: AddressKind;
  owner_id: string;
};

export function addressKey(local: string, domain: string): string {
  return `${local.trim().toLowerCase()}@${domain.trim().toLowerCase()}`;
}

/**
 * Registered addresses stay reserved. `removed_at` does not free the row:
 * `address` is the primary key, so a new mailbox, alias, or forward cannot take it.
 * No Worker path sets `removed_at`.
 */
export async function lookupAddress(env: Env, address: string): Promise<AddressOwner | null> {
  return env.DB.prepare(`SELECT address, kind, owner_id FROM address_registry WHERE address = ?`)
    .bind(address.trim().toLowerCase())
    .first<AddressOwner>();
}

/** Registry rows are never deleted, including when the mailbox or route that owned the address is gone. */
export async function refuseAddressRegistryDelete(address: string): Promise<never> {
  const reserved = address.trim().toLowerCase();
  throw new Error(`Address registry rows are never deleted. ${reserved} stays reserved once it is registered.`);
}

/**
 * Copy mailbox and route addresses that are not in the registry yet. Does not touch messages.
 * A removed alias_targets row still counts as present, so this backfill does not insert it again.
 */
export async function syncAddressRegistry(env: Env): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM bots b
         WHERE b.address_local != '' AND b.domain != ''
           AND NOT EXISTS (
             SELECT 1 FROM address_registry r
             WHERE r.address = lower(b.address_local) || '@' || lower(b.domain)
           )) AS mailboxes,
       (SELECT COUNT(*) FROM routes t
         WHERE t.local_part != '' AND t.domain != ''
           AND NOT EXISTS (
             SELECT 1 FROM address_registry r
             WHERE r.address = lower(t.local_part) || '@' || lower(t.domain)
           )) AS routes,
       (SELECT COUNT(*) FROM routes a
         WHERE a.kind = 'alias' AND a.target != ''
           AND NOT EXISTS (SELECT 1 FROM alias_targets t WHERE t.route_id = a.id)) AS aliases`,
  ).first<{ mailboxes: number; routes: number; aliases: number }>();
  if (!pending || (pending.mailboxes === 0 && pending.routes === 0 && pending.aliases === 0)) return;
  const stamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO address_registry (address, kind, owner_id, created_at)
       SELECT lower(address_local) || '@' || lower(domain), 'mailbox', id, ?
       FROM bots
       WHERE address_local != '' AND domain != ''`,
    ).bind(stamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO address_registry (address, kind, owner_id, created_at)
       SELECT lower(local_part) || '@' || lower(domain),
              CASE WHEN kind = 'alias' THEN 'alias' ELSE 'forward' END,
              id,
              ?
       FROM routes
       WHERE local_part != '' AND domain != ''`,
    ).bind(stamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO alias_targets (route_id, bot_id, created_at)
       SELECT id, target, ?
       FROM routes
       WHERE kind = 'alias' AND target != ''`,
    ).bind(stamp),
  ]);
}
