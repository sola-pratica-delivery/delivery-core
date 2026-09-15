import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = buildApp(config);

app
  .listen({ host: config.host, port: config.port })
  .then((address) => {
    app.log.info(`delivery-core upload server listening on ${address}`);
  })
  .catch((error: unknown) => {
    app.log.error(error, "failed to start upload server");
    process.exit(1);
  });