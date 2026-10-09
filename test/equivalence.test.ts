import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";
import { referenceListCreators } from "./reference.ts";

const CAMPAIGNS: Array<[string, string]> = [
  [CAMPAIGN_ID, '["beleza","moda"]'],
  ["cmp_tech", '["tech"]'],
  ["cmp_wide", '["beleza","moda","tech","games","comida","fitness"]'],
  ["cmp_dup", '["beleza","beleza"]'],
  ["cmp_none", '["inexistente"]'],
  ["cmp_empty", "[]"],
];
const PAGES = [
  { limit: 20, offset: 0 },
  { limit: 1, offset: 0 },
  { limit: 50, offset: 13 },
  { limit: 20, offset: 100_000 },
];

function seeded(creators: number, seedValue: number): DatabaseSync {
  const db = openDatabase();
  seed(db, { creators, seed: seedValue });
  const insert = db.prepare("INSERT INTO campaigns (id, name, niches_json) VALUES (?, ?, ?)");
  for (const [id, niches] of CAMPAIGNS.slice(1)) insert.run(id, id, niches);
  return db;
}

async function expectSameAsReference(db: DatabaseSync): Promise<void> {
  for (const [campaignId] of [...CAMPAIGNS, ["cmp_missing"]]) {
    for (const page of PAGES) {
      const input = { campaignId, ...page };
      expect(await listCreators(db, input), `${campaignId} ${JSON.stringify(page)}`).toEqual(
        referenceListCreators(db, input),
      );
    }
  }
}

describe("equivalência com a implementação original", () => {
  it.each([
    [0, 7],
    [1, 7],
    [80, 7],
    [300, 1],
    [300, 42],
  ])("mesma resposta com %i criadores (seed %i)", async (creators, seedValue) => {
    await expectSameAsReference(seeded(creators, seedValue));
  });

  it("continua igual depois de alterar, mover e apagar dados", async () => {
    const db = seeded(120, 3);
    db.exec(`
      UPDATE metrics SET views = views + 1000000 WHERE id = 'met_acc_crt_0010_0_0';
      UPDATE metrics SET captured_at = '2030-01-01T00:00:00.000Z' WHERE id = 'met_acc_crt_0011_0_0';
      DELETE FROM metrics WHERE account_id = 'acc_crt_0012_0';
      UPDATE metrics SET account_id = 'acc_crt_0014_0' WHERE account_id = 'acc_crt_0013_0';
      UPDATE social_accounts SET creator_id = 'crt_0016' WHERE creator_id = 'crt_0015';
      DELETE FROM social_accounts WHERE creator_id = 'crt_0017';
      UPDATE creators SET niches_json = '["beleza","moda","beleza"]' WHERE id = 'crt_0018';
      UPDATE creators SET niches_json = '["games"]' WHERE id = 'crt_0019';
      DELETE FROM creators WHERE id = 'crt_0020';
      INSERT OR REPLACE INTO creators VALUES ('crt_0021', 'Substituído', '["moda"]', '');
      INSERT OR REPLACE INTO social_accounts VALUES ('acc_crt_0022_0', 'crt_0023', 'instagram');
      UPDATE creators SET id = 'crt_9999' WHERE id = 'crt_0024';
      INSERT INTO metrics VALUES ('met_orphan', 'acc_new', 5, '2030-01-01T00:00:00.000Z', '');
      INSERT INTO social_accounts VALUES ('acc_new', 'crt_0025', 'tiktok');
      DELETE FROM deliveries WHERE creator_id = 'crt_0026';
    `);
    await expectSameAsReference(db);
  });

  it("compara nichos com a mesma igualdade do JavaScript", async () => {
    const db = openDatabase();
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_types', 'Tipos', '["beleza", 1, true, null, {"a":1}, [1]]');
      INSERT INTO creators VALUES
        ('crt_text', 'Texto', '["beleza"]', ''),
        ('crt_number', 'Número', '[1.0]', ''),
        ('crt_number_text', 'Número como texto', '["1"]', ''),
        ('crt_bool', 'Booleano', '[true, false]', ''),
        ('crt_null', 'Nulo', '[null]', ''),
        ('crt_object', 'Objeto', '[{"a":1}]', ''),
        ('crt_array', 'Array', '[[1]]', ''),
        ('crt_case', 'Caixa', '["Beleza"]', '');
    `);
    const input = { campaignId: "cmp_types", limit: 50, offset: 0 };
    expect(await listCreators(db, input)).toEqual(referenceListCreators(db, input));
  });

  it("enxerga dados que já existiam antes das tabelas derivadas", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/conty-backfill-${process.pid}.db`;
    // Simula um banco do schema antigo: sem triggers nem tabelas derivadas.
    const legacy = openDatabase(path);
    const triggers = legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
      name: string;
    }>;
    for (const { name } of triggers) legacy.exec(`DROP TRIGGER ${name}`);
    legacy.exec("DROP TABLE creator_niches; DROP TABLE creator_reach;");
    seed(legacy, { creators: 50, seed: 9 });
    legacy.close();

    const db = openDatabase(path);
    const input = { campaignId: CAMPAIGN_ID, limit: 20, offset: 0 };
    expect(await listCreators(db, input)).toEqual(referenceListCreators(db, input));
    db.close();
    (await import("node:fs")).rmSync(path, { force: true });
  });
});

describe("custo constante", () => {
  it.each([80, 600, 5000])("responde a página com 1 query com %i criadores", async (creators) => {
    const db = openDatabase();
    seed(db, { creators, seed: 7 });
    resetQueryCount();
    await listCreators(db, { campaignId: CAMPAIGN_ID, limit: 20, offset: 0 });
    expect(getQueryCount()).toBe(1);
  });
});
