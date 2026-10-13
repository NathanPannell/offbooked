import { buildApp } from "./app.ts";

const app = buildApp({ revision: process.env.APP_REVISION ?? process.env.RAILWAY_GIT_COMMIT_SHA });
const port = Number(process.env.PORT ?? 8080);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
