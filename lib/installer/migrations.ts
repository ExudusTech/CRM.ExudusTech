import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const SCHEMA_PATH = path.resolve(
  process.cwd(),
  'supabase/migrations/20251201000000_schema_init.sql'
);

function needsSsl(connectionString: string) {
  return !/sslmode=disable/i.test(connectionString);
}

/**
 * Função pública `runSchemaMigration` do projeto.
 *
 * @param {string} dbUrl - Parâmetro `dbUrl`.
 * @returns {Promise<void>} Retorna uma Promise resolvida sem valor.
 */
export async function runSchemaMigration(dbUrl: string) {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');

  const client = new Client({
    connectionString: dbUrl,
    ssl: needsSsl(dbUrl) ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  try {
    await client.query(schemaSql);
  } finally {
    await client.end();
  }
}
