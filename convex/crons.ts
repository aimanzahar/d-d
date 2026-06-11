import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// Backstop: a crashed GM action that never released its lock gets swept here.
export const repairStaleGmLocks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const campaigns = await ctx.db.query("campaigns").collect();
    const now = Date.now();
    for (const campaign of campaigns) {
      if (campaign.gm.status !== "running") continue;
      if (now - (campaign.gm.startedAt ?? 0) < 5 * 60 * 1000) continue;

      await ctx.db.patch(campaign._id, {
        gm: { status: "idle", generation: campaign.gm.generation },
      });
      // Orphaned streaming messages become errors (or vanish if empty)
      const streaming = await ctx.db
        .query("messages")
        .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
        .order("desc")
        .take(5);
      for (const m of streaming) {
        if (m.kind === "gm" && m.status === "streaming") {
          if (m.content.trim() === "") await ctx.db.delete(m._id);
          else await ctx.db.patch(m._id, { status: "error" });
        }
      }
      // Re-enqueue if work is waiting
      const pending = await ctx.db
        .query("messages")
        .withIndex("by_campaign_unprocessed", (q) =>
          q.eq("campaignId", campaign._id).eq("processed", false),
        )
        .first();
      if (pending) {
        const generation = campaign.gm.generation + 1;
        await ctx.db.patch(campaign._id, {
          gm: { status: "running", startedAt: now, generation },
        });
        await ctx.scheduler.runAfter(0, internal.gm.turn.respond, {
          campaignId: campaign._id,
          generation,
        });
      }
    }
  },
});

const crons = cronJobs();
crons.interval("repair stale GM locks", { minutes: 5 }, internal.crons.repairStaleGmLocks, {});
export default crons;
