const express = require('express');
const morgan = require('morgan');
const app = express();

// ─── Process-level safety nets ──────────────────────────────────────────
// Prevent the proxy from crashing on stray unhandled errors (e.g., H2
// stream errors that fire after listeners are removed, network drops, etc.)
process.on('uncaughtException', (err) => {
  console.error(`[PROCESS] Uncaught exception (non-fatal): ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[PROCESS] Unhandled rejection (non-fatal):`, reason);
});

const config = require('./config/config');
const routes = require('./routes');

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(morgan(process.env.MORGAN_FORMAT ?? 'tiny'));

app.use("/", routes)

const server = app.listen(config.port, () => {
    console.log(`The server listens port: ${config.port}`);
});

// Kill every Node.js HTTP timeout so 24-hour overnight agent runs are
// never interrupted by the proxy.  0 = unlimited / disabled.
server.timeout = 0;            // socket idle timeout — disabled
server.requestTimeout = 0;     // total request duration — disabled
server.headersTimeout = 0;     // time to receive headers — disabled
server.keepAliveTimeout = 0;   // keep-alive idle gap — disabled
