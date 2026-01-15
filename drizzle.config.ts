import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import config from "@/config/config"

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: config.dbFileName,
  },
});