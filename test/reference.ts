import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "../src/clock.ts";
import type { CreatorMatch, CreatorPage } from "../src/list-creators.ts";

// A implementação original, linha a linha, como referência de comportamento.
// Usa o banco direto para não entrar na contagem de queries.
export function referenceListCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): CreatorPage | null {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(input.campaignId) as
    | { niches_json: string }
    | undefined;
  if (!campaign) return null;

  const creators = db.prepare("SELECT * FROM creators").all() as Array<{
    id: string;
    name: string;
    niches_json: string;
  }>;
  const since = deliveriesSince();
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const campaignNiches = JSON.parse(campaign.niches_json) as unknown[];
    const creatorNiches = JSON.parse(creator.niches_json) as unknown[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    const accounts = db.prepare("SELECT * FROM social_accounts WHERE creator_id = ?").all(creator.id) as Array<{
      id: string;
    }>;
    let latestReach = 0;
    for (const account of accounts) {
      const metric = db
        .prepare("SELECT * FROM metrics WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1")
        .get(account.id) as { views: number } | undefined;
      if (metric) latestReach += metric.views;
    }

    const deliveries = db
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE creator_id = ? AND delivered_at >= ?")
      .get(creator.id, since) as { n: number };

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: latestReach,
      deliveries_90d: Number(deliveries.n),
    });
  }

  scored.sort((left, right) => {
    if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
    if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
