/**
 * One-time (but idempotent) backfill: give every existing bot the plugin structure a bot created
 * after this change gets for free.
 *
 * For each bot:
 *   1. its owner gets every builtin install (core today),
 *   2. the bot gets its own `local` plugin,
 *   3. every `skills` / `bot_mcp_servers` row of that bot with a null `plugin_id` is adopted into
 *      that local plugin — those rows ARE the user's own recorded experience, which is exactly what
 *      `local` means.
 *
 * Safe to re-run: every step is an upsert or a null-guarded update, so a second pass reports zero
 * adopted rows and changes nothing. Safe to run before the code deploy too — writing `plugin_id` on
 * existing rows changes no current behaviour; the columns are only read by the new resolution path.
 *
 * Any `scope='public'` skill row is reported but NOT migrated: the design retires that scope in favour
 * of per-bot rows owned by a builtin plugin, and inventing an owner for a row we didn't write would
 * guess at whose it is. There are none in practice (that's what made the old `loadBotSkills` OR-branch
 * harmless); if this prints a non-zero count, decide deliberately rather than letting a script pick.
 *
 * Run: pnpm --filter @i-bot/api exec tsx --env-file=../../.env scripts/backfill-plugins.ts
 */
// oxlint-disable no-await-in-loop -- bot-at-a-time on purpose: bounded connection use over a table of
// unknown size, and per-bot progress printed as it goes so a long run is watchable and resumable.
import { botMcpServers, createDb, skills as skillsTable } from "@i-bot/db";
import { and, eq, isNull } from "drizzle-orm";
import { ensureBotPlugins } from "../src/plugins/builtin.js";
import { localPluginIdFor } from "../src/plugins/repository.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createDb(url);

  const bots = await db.query.bots.findMany({ columns: { id: true, name: true, ownerId: true } });
  console.log(`→ ${bots.length} bot(s) to backfill`);

  let adoptedSkills = 0;
  let adoptedMcp = 0;
  let localsCreated = 0;

  for (const bot of bots) {
    const before = await localPluginIdFor(db, bot.id);
    await ensureBotPlugins(db, { botId: bot.id, ownerId: bot.ownerId, botName: bot.name });
    const pluginId = await localPluginIdFor(db, bot.id);
    if (!pluginId) {
      console.warn(`  ! ${bot.name} (${bot.id}): no local plugin after ensure — skipped`);
      continue;
    }
    if (!before) localsCreated += 1;

    // Adopt this bot's own un-owned rows. Scoped by botId AND `plugin_id is null`, so a row already
    // belonging to some plugin is never re-pointed.
    const skillRows = await db
      .update(skillsTable)
      .set({ pluginId })
      .where(
        and(
          eq(skillsTable.scope, "bot"),
          eq(skillsTable.ownerRef, bot.id),
          isNull(skillsTable.pluginId),
        ),
      )
      .returning({ id: skillsTable.id });
    adoptedSkills += skillRows.length;

    const mcpRows = await db
      .update(botMcpServers)
      .set({ pluginId })
      .where(and(eq(botMcpServers.botId, bot.id), isNull(botMcpServers.pluginId)))
      .returning({ id: botMcpServers.id });
    adoptedMcp += mcpRows.length;

    console.log(
      `  ✓ ${bot.name} (${bot.id}): ${skillRows.length} skill(s), ${mcpRows.length} MCP server(s)`,
    );
  }

  const publicSkills = await db.query.skills.findMany({
    where: eq(skillsTable.scope, "public"),
    columns: { id: true, name: true },
  });

  console.log("\n— summary —");
  console.log(`local plugins created: ${localsCreated}`);
  console.log(`skills adopted:        ${adoptedSkills}`);
  console.log(`mcp servers adopted:   ${adoptedMcp}`);
  if (publicSkills.length > 0) {
    console.log(
      `\n! ${publicSkills.length} scope='public' skill row(s) NOT migrated — they have no owner, ` +
        `and the new loadBotSkills no longer reads them. Decide where each belongs:\n` +
        publicSkills.map((s) => `    ${s.id}  ${s.name}`).join("\n"),
    );
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("backfill failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
