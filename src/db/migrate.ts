import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Db } from './pool';

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
}
