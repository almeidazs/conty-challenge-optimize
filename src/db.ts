import { DatabaseSync, type StatementSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niches_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niches_json TEXT NOT NULL,
  raw_payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  platform TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  views INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  raw_payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL
);
`;

/**
 * Chave de comparação de um nicho, com a mesma igualdade do `===` sobre o
 * JSON.parse: texto, número (1 e 1.0 são iguais), booleano e null. Objeto e
 * array nunca são iguais a nada, então ficam de fora (NULL).
 */
export function nicheKey(item: string): string {
  return `CASE ${item}.type
    WHEN 'text' THEN 's:' || ${item}.value
    WHEN 'integer' THEN 'n:' || CAST(${item}.value AS REAL)
    WHEN 'real' THEN 'n:' || ${item}.value
    WHEN 'true' THEN 'b:1'
    WHEN 'false' THEN 'b:0'
    WHEN 'null' THEN 'null'
  END`;
}

/** O JSON se for um array válido; senão NULL, e json_each não devolve nada. */
export function jsonArray(json: string): string {
  return `CASE WHEN json_valid(${json}) THEN CASE WHEN json_type(${json}) = 'array' THEN ${json} END END`;
}

function insertNiches(creatorId: string, niches: string, from = ""): string {
  return `INSERT OR IGNORE INTO creator_niches (niche, creator_id, slot)
    SELECT ${nicheKey("item")}, ${creatorId}, item.key
    FROM ${from}json_each(${jsonArray(niches)}) AS item
    WHERE ${nicheKey("item")} IS NOT NULL;`;
}

// Alcance = soma das views da métrica mais recente de cada conta (maior
// captured_at, empate por id decrescente), recalculado para cada criador de `creatorIds`.
function refreshReach(creatorIds: string): string {
  return `INSERT OR REPLACE INTO creator_reach (creator_id, reach)
    SELECT target.creator_id, COALESCE((
      SELECT SUM((
        SELECT metric.views FROM metrics AS metric
        WHERE metric.account_id = account.id
        ORDER BY metric.captured_at DESC, metric.id DESC
        LIMIT 1
      ))
      FROM social_accounts AS account
      WHERE account.creator_id = target.creator_id
    ), 0)
    FROM (${creatorIds}) AS target;`;
}

/**
 * Índices de cobertura e duas tabelas derivadas, mantidas por triggers na
 * mesma transação de cada escrita. Funcionam como um cache que nunca fica
 * desatualizado: a listagem lê o score de nicho e o alcance prontos, sem
 * percorrer todos os criadores, contas e métricas a cada requisição.
 */
const DERIVED = `
CREATE INDEX IF NOT EXISTS social_accounts_by_creator ON social_accounts (creator_id, id);
CREATE INDEX IF NOT EXISTS metrics_latest_by_account ON metrics (account_id, captured_at DESC, id DESC, views);
CREATE INDEX IF NOT EXISTS deliveries_by_creator ON deliveries (creator_id, delivered_at);

CREATE TABLE IF NOT EXISTS creator_niches (
  niche TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  PRIMARY KEY (niche, creator_id, slot)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS creator_niches_by_creator ON creator_niches (creator_id);

CREATE TABLE IF NOT EXISTS creator_reach (
  creator_id TEXT PRIMARY KEY,
  reach INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS creators_after_insert AFTER INSERT ON creators BEGIN
  DELETE FROM creator_niches WHERE creator_id = NEW.id;
  ${insertNiches("NEW.id", "NEW.niches_json")}
END;
CREATE TRIGGER IF NOT EXISTS creators_after_update AFTER UPDATE OF id, niches_json ON creators BEGIN
  DELETE FROM creator_niches WHERE creator_id IN (OLD.id, NEW.id);
  ${insertNiches("NEW.id", "NEW.niches_json")}
END;
CREATE TRIGGER IF NOT EXISTS creators_after_delete AFTER DELETE ON creators BEGIN
  DELETE FROM creator_niches WHERE creator_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS social_accounts_after_insert AFTER INSERT ON social_accounts BEGIN
  ${refreshReach("SELECT NEW.creator_id AS creator_id")}
END;
CREATE TRIGGER IF NOT EXISTS social_accounts_after_update AFTER UPDATE OF id, creator_id ON social_accounts BEGIN
  ${refreshReach("SELECT OLD.creator_id AS creator_id UNION SELECT NEW.creator_id")}
END;
CREATE TRIGGER IF NOT EXISTS social_accounts_after_delete AFTER DELETE ON social_accounts BEGIN
  ${refreshReach("SELECT OLD.creator_id AS creator_id")}
END;

CREATE TRIGGER IF NOT EXISTS metrics_after_insert AFTER INSERT ON metrics BEGIN
  ${refreshReach("SELECT creator_id FROM social_accounts WHERE id = NEW.account_id")}
END;
CREATE TRIGGER IF NOT EXISTS metrics_after_update AFTER UPDATE OF id, account_id, views, captured_at ON metrics BEGIN
  ${refreshReach("SELECT creator_id FROM social_accounts WHERE id IN (OLD.account_id, NEW.account_id)")}
END;
CREATE TRIGGER IF NOT EXISTS metrics_after_delete AFTER DELETE ON metrics BEGIN
  ${refreshReach("SELECT creator_id FROM social_accounts WHERE id = OLD.account_id")}
END;
`;

// Banco que já tinha dados antes das tabelas derivadas existirem.
const BACKFILL = `
${insertNiches("creator.id", "creator.niches_json", "creators AS creator, ")}
${refreshReach("SELECT DISTINCT creator_id FROM social_accounts")}
`;

type SqlValue = string | number | bigint | null;

let queryCount = 0;

export function resetQueryCount(): void {
  queryCount = 0;
}

export function getQueryCount(): number {
  return queryCount;
}

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  // INSERT OR REPLACE também dispara os triggers de DELETE da linha substituída.
  db.exec("PRAGMA recursive_triggers = ON");
  db.exec(SCHEMA);
  const isNew = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'creator_reach'").get() === undefined;
  db.exec(DERIVED);
  if (isNew) db.exec(BACKFILL);
  return db;
}

// Preparar um statement custa mais que executá-lo: cada SQL é preparado uma vez por banco.
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepare(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

export async function all<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): Promise<T[]> {
  queryCount += 1;
  return prepare(db, sql).all(...params) as T[];
}

export async function get<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): Promise<T | undefined> {
  queryCount += 1;
  const row = prepare(db, sql).get(...params);
  if (row === undefined || row === null) return undefined;
  return row as T;
}
