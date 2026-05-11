import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const app = buildApp({ logger: true });

try {
  const address = await app.listen({ port, host });
  app.log.info(`Backend listening at ${address}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
