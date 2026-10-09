import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, jsonArray, nicheKey } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type Row = {
  total: number;
  id: string | null;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

/**
 * Uma query só, de tamanho fixo: o score sai de `creator_niches` e o alcance de
 * `creator_reach` (mantidas por triggers em src/db.ts), o SQLite ordena e
 * pagina, e as entregas são contadas só para as linhas da página. A campanha
 * entra pelo LEFT JOIN, então campanha sem criador compatível ainda devolve
 * uma linha (com o total), e campanha inexistente não devolve nenhuma.
 */
const LIST_CREATORS = `
WITH campaign_niches AS (
  SELECT ${nicheKey("item")} AS niche
  FROM campaigns AS campaign, json_each(${jsonArray("campaign.niches_json")}) AS item
  WHERE campaign.id = ?1
),
-- CROSS JOIN e "+" fixam o plano: busca pelo nicho da campanha. Sem eles,
-- depois de um ANALYZE o SQLite passa a varrer creator_niches inteira para
-- evitar o GROUP BY, e a query fica ~4x mais lenta.
matches AS MATERIALIZED (
  SELECT entry.creator_id AS id, COUNT(*) AS niche_score
  FROM campaign_niches AS wanted
  CROSS JOIN creator_niches AS entry ON entry.niche = wanted.niche
  GROUP BY +entry.creator_id
),
page AS (
  SELECT match.id, match.niche_score, COALESCE(reach.reach, 0) AS latest_reach
  FROM matches AS match
  LEFT JOIN creator_reach AS reach ON reach.creator_id = match.id
  ORDER BY match.niche_score DESC, latest_reach DESC, match.id ASC
  LIMIT ?2 OFFSET ?3
)
SELECT
  (SELECT COUNT(*) FROM matches) AS total,
  page.id,
  creator.name,
  page.niche_score,
  page.latest_reach,
  (
    SELECT COUNT(*) FROM deliveries AS delivery
    WHERE delivery.creator_id = page.id AND delivery.delivered_at >= ?4
  ) AS deliveries_90d
FROM campaigns AS campaign
LEFT JOIN page
LEFT JOIN creators AS creator ON creator.id = page.id
WHERE campaign.id = ?1
ORDER BY page.niche_score DESC, page.latest_reach DESC, page.id ASC
`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const rows = await all<Row>(
    db,
    LIST_CREATORS,
    input.campaignId,
    input.limit,
    input.offset,
    deliveriesSince(),
  );
  const [first] = rows;
  if (!first) return null;

  const creators: CreatorMatch[] = [];
  for (const row of rows) {
    if (row.id === null) continue;
    creators.push({
      id: row.id,
      name: row.name,
      niche_score: row.niche_score,
      latest_reach: row.latest_reach,
      deliveries_90d: row.deliveries_90d,
    });
  }
  return { campaign_id: input.campaignId, total: first.total, creators };
}
