import "dotenv/config";

import { z } from "zod";

import { createPrismaClient } from "../src/db/prisma.js";

const databaseUrl = z.string().startsWith("postgresql://").parse(process.env["DATABASE_URL"]);
const database = createPrismaClient(databaseUrl);

try {
  await database.$connect();
  console.info("Database connection verified; no default application records are required.");
} finally {
  await database.$disconnect();
}
