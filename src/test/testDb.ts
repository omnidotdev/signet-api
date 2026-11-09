import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../lib/db/client.ts";
import * as schema from "../lib/db/schema.ts";

/** Create an isolated in-process Postgres (PGlite) with migrations applied */
export const createTestDb = async (): Promise<Db> => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db as unknown as Db;
};
