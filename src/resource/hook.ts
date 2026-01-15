import {
  eq,
  InferInsertModel,
  Table,
  TableConfig,
  InferSelectModel,
  count,
  getTableName,
} from "drizzle-orm";
import { Response, Router } from "express";
import { db } from "@/db/db";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import { AnyColumn } from "drizzle-orm";
import z from "zod";
import { createResourceFilter } from "./filter";
import expressWs from "express-ws";
import { v4 as uuidv4 } from "uuid";
import {
  createSubscription,
  Event,
  kvDelete,
  kvScan,
  pushInsertsToSubscriptions,
  removeSubscription,
} from "./subscription";

interface BatchConfig {
  create?: number;
  update?: number;
  replace?: number;
  delete?: number;
}

export interface ResourceConfig<
  TConfig extends TableConfig,
  TTable extends Table<TConfig>,
> {
  id: AnyColumn<{ tableName: TTable["_"]["name"] }>;
  batch?: BatchConfig;
}

export const useResource = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  config: ResourceConfig<TConfig, Table<TConfig>>
) => {
  const handlerId = uuidv4();
  const resourceName = getTableName(schema);
  const idColumnName = config.id.name;

  const router = Router() as expressWs.Router;

  const filterer = createResourceFilter(schema);

  const insertSchema = createInsertSchema(schema);
  const parseInsert = (data: any) => {
    return insertSchema.parse(data) as InferInsertModel<Table<TConfig>>;
  };
  const parseMultiInsert = (data: any) => {
    return z.object({ items: z.array(insertSchema) }).parse(data) as {
      items: InferInsertModel<Table<TConfig>>[];
    };
  };
  const updateSchema = createUpdateSchema(schema);
  const parseUpdate = (data: any) => {
    return updateSchema.parse(data) as InferSelectModel<Table<TConfig>>;
  };

  const batchConfig = config.batch ?? {};

  const {
    create: batchCreate = 0,
    update: batchUpdate = 0,
    replace: batchReplace = 0,
    delete: batchDelete = 0,
  } = batchConfig;

  if (batchCreate) {
    router.post("/batch", async (req, res, next) => {
      const data = parseMultiInsert(req.body);
      if (data.items.length > batchCreate) {
        return res.status(400).send({
          error: `Batch create limit exceeded. Max ${batchCreate} items allowed.`,
        });
      }

      const object = await db.insert(schema).values(data.items).returning();

      pushInsertsToSubscriptions(resourceName, filterer, object);

      res.status(200).send(object);
    });
  }

  if (batchUpdate) {
    router.patch("/batch", async (req, res, next) => {
      const filterQuery = req.query.filter?.toString() ?? "";
      const filter = filterer.convert(filterQuery);

      const data = parseUpdate(req.body);

      try {
        const dbResponse = await db.transaction(async (tx) => {
          const dbResponse = await tx
            .update(schema)
            .set(data)
            .where(filter)
            .run();

          if (dbResponse.rowsAffected > batchUpdate) {
            throw new Error(`update-limit`);
          }

          return dbResponse;
        });

        res.status(200).send({ count: dbResponse.rowsAffected });
      } catch (error) {
        if (error instanceof Error && error.message === "update-limit") {
          return res.status(400).send({
            error: `Batch update limit exceeded. Max ${batchUpdate} items allowed.`,
          });
        }

        throw error;
      }
    });
  }

  if (batchReplace) {
    router.put("/batch", async (req, res, next) => {
      const filterQuery = req.query.filter?.toString() ?? "";
      const filter = filterer.convert(filterQuery);

      const data = parseInsert(req.body);

      try {
        const dbResponse = await db.transaction(async (tx) => {
          const dbResponse = await tx
            .update(schema)
            .set(data)
            .where(filter)
            .run();

          if (dbResponse.rowsAffected > batchReplace) {
            throw new Error(`update-limit`);
          }

          return dbResponse;
        });

        res.status(200).send({ count: dbResponse.rowsAffected });
      } catch (error) {
        if (error instanceof Error && error.message === "update-limit") {
          return res.status(400).send({
            error: `Batch replace limit exceeded. Max ${batchReplace} items allowed.`,
          });
        }

        throw error;
      }
    });
  }

  if (batchDelete) {
    router.delete("/batch", async (req, res, next) => {
      const filterQuery = req.query.filter?.toString() ?? "";
      const filter = filterer.convert(filterQuery);

      try {
        const dbResponse = await db.transaction(async (tx) => {
          const dbResponse = await tx.delete(schema).where(filter).run();

          if (dbResponse.rowsAffected > batchDelete) {
            throw new Error(`update-limit`);
          }

          return dbResponse;
        });

        res.status(200).send({ count: dbResponse.rowsAffected });
      } catch (error) {
        if (error instanceof Error && error.message === "update-limit") {
          return res.status(400).send({
            error: `Batch delete limit exceeded. Max ${batchDelete} items allowed.`,
          });
        }

        throw error;
      }
    });
  }

  // subscribe
  const clients = new Map<string, { res: Response }>();
  router.get("/subscribe", async (req, res) => {
    const filterQuery = req.query.filter?.toString() ?? "";
    const filter = filterer.convert(filterQuery);

    console.log("New subscriber with filter:", filterQuery);

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();

    res.write(`event: connected\ndata: {}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 20000);

    const items = await db.select().from(schema).where(filter);

    const subscriptionId = await createSubscription(
      resourceName,
      filterQuery,
      handlerId,
      null /* todo */,
      new Set(items.map((item) => String(item[idColumnName])))
    );

    const client = { res };

    new Promise(async (resolve) => {
      for (const item of items) {
        const msg = {
          id: uuidv4(),
          type: "existing",
          object: item,
          subscriptionId,
        } satisfies Event;

        client.res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      }

      resolve(undefined);
    }).then(() => {
      console.log("sent all existing items for subscription:", subscriptionId);
    });

    clients.set(subscriptionId, client);

    req.on("close", async () => {
      console.log("Client disconnected:", filterQuery);
      clearInterval(heartbeat);
      clients.delete(subscriptionId);
      await removeSubscription(resourceName, subscriptionId)
    });
  });
  setInterval(async () => {
    for await (const { key, value } of kvScan<Event>(
      "event::" + resourceName + "::" + handlerId + "::**"
    )) {
      const client = clients.get(value.subscriptionId);

      if (!client) continue;

      await kvDelete(key);

      client.res.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
    }
  }, 100);

  // count
  router.get("/count", async (req, res, next) => {
    const filterQuery = req.query.filter?.toString() ?? "";
    const filter = filterer.convert(filterQuery);

    const [countData] = await db
      .select({ count: count() })
      .from(schema)
      .where(filter);

    res.status(200).send({ count: countData?.count ?? 0 });
  });

  // create single
  router.post("/", async (req, res, next) => {
    const data = parseInsert(req.body);

    const [object] = await db.insert(schema).values(data).returning();

    pushInsertsToSubscriptions(resourceName, filterer, [object]);

    res.status(200).send(object);
  });

  // read all
  router.get("/", async (req, res, next) => {
    const filterQuery = req.query.filter?.toString() ?? "";
    const filter = filterer.convert(filterQuery);

    const items = await db.select().from(schema).where(filter);

    res.status(200).send({ items });
  });

  // read single
  router.get("/:id", async (req, res, next) => {
    const id = req.params.id;

    const [item] = await db.select().from(schema).where(eq(config.id, id));

    if (!item) return res.status(404).send({});

    res.status(200).send(item);
  });

  // update single (replace)
  router.put("/:id", async (req, res, next) => {
    const id = req.params.id;
    const data = parseInsert(req.body);

    const [item] = await db
      .update(schema)
      .set(data)
      .where(eq(config.id, id))
      .returning();

    if (!item) return res.status(404).send({});

    res.status(200).send(item);
  });

  // update single (partial)
  router.patch("/:id", async (req, res, next) => {
    const id = req.params.id;
    const data = parseUpdate(req.body);

    const [item] = await db
      .update(schema)
      .set(data)
      .where(eq(config.id, id))
      .returning();

    if (!item) return res.status(404).send({});

    res.status(200).send(item);
  });

  // delete single
  router.delete("/:id", async (req, res, next) => {
    const id = req.params.id;

    const [item] = await db.delete(schema).where(eq(config.id, id)).returning();

    if (!item) return res.status(404).send({});

    res.status(204).send({});
  });

  return router;
};
