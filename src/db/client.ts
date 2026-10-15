import "dotenv/config";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

function createPool() {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    allowExitOnIdle: true,
  });
}

let activePool = createPool();

export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_target, prop, receiver) {
    if (activePool.ended) {
      activePool = createPool();
    }
    const val = Reflect.get(activePool, prop, receiver);
    return typeof val === "function" ? val.bind(activePool) : val;
  },
});

/** Runs fn inside a transaction; rolls back on any error. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}