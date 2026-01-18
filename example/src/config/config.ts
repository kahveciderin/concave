import dotenv from "dotenv";
import { createEnv, envVariable } from "@kahveciderin/concave/env";
import { z } from "zod";

dotenv.config();

export const env = createEnv({
  serverConfig: {
    port: envVariable(process.env.PORT, z.string().min(1).transform(Number)),
  },
  dbConfig: {
    dbFileName: envVariable(process.env.DB_FILE_NAME, z.string().min(1)),
  },
  NODE_ENV: z.enum(["development", "production"]),
  PUBLIC_VERSION: z.string().min(1),
});
