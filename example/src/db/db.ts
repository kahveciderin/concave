import { env } from "../config/config";
import { drizzle } from "drizzle-orm/libsql";

export const db = drizzle(env.dbConfig.dbFileName);
