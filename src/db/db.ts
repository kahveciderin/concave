import config from "@/config/config";
import { drizzle } from "drizzle-orm/libsql";

export const db = drizzle(config.dbFileName);
