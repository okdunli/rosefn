/**
 * The blog-pg config: ONE plugin, and it is the store driver.
 *
 * The cluster's IPC relay already shares $store between the workers of ONE
 * machine. This plugin extends it across machines with Postgres itself -
 * LISTEN/NOTIFY, no redis, no second dependency: the database you already
 * run is the bus.
 *
 * It is also the worked example of the bridge every cross-machine driver
 * uses: `onServe` runs in the worker process (that is where a node-only
 * client library may live - the config is never bundled into dist/), and
 * `meta.store` is the seam into the server module's store map:
 *
 *   store.install(send)  - every $store write in this worker calls send()
 *   store.deliver(n, v)  - a patch from anywhere else enters the store
 *
 * Delete this file's default export and the app is unchanged: the relay
 * covers a single machine, which is what `rosefn serve` on one box is.
 */
import pg from 'pg';

const CHANNEL = 'rosefn_store';

export default [
  {
    name: 'pg-store',
    async onServe({ store }) {
      const url = process.env.DATABASE_URL;
      if (!url) {
        throw new Error('DATABASE_URL is not set - this driver needs the Postgres connection string');
      }
      // One dedicated connection for LISTEN (a pooled one would be handed
      // to someone else between notifications) and the pool for sends.
      const pool = new pg.Pool({ connectionString: url });
      const listener = await pool.connect();
      await listener.query(`LISTEN ${CHANNEL}`);
      listener.on('notification', (msg) => {
        const { name, value } = JSON.parse(msg.payload);
        store.deliver(name, value);
      });
      // Every write leaves this worker as a NOTIFY. The sender is a
      // subscriber too, so it re-applies its own value - idempotent, and
      // one less special case than the cluster relay's skip-the-writer.
      store.install((name, value) => {
        pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ name, value })])
          .catch((err) => console.error('Rosefn: pg-store notify failed:', err.message));
      });
      console.log(`🌹 pg-store: $store writes broadcast on Postgres channel ${CHANNEL}`);
    },
  },
];
