import express from "express";
import config from "@/config/config";
import { useResource } from "./resource/hook";
import { usersTable } from "./db/schema";
import expressWs from "express-ws";

const { app, getWss, applyTo } = expressWs(express());

app.use(express.json());

app.use(
  "/user",
  useResource(usersTable, {
    id: usersTable.id,
    batch: {
      delete: 1,
    },
  })
);

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});
