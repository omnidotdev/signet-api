import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Db | undefined;

/** Lazily construct the shared database connection from DATABASE_URL */
export const getDb = (): Db => {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL not set");
  }
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema });
  return db;
};

/** Apply pending migrations, run once on boot before serving */
export const runMigrations = async (): Promise<void> => {
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
};
