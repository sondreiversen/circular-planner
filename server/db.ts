import { Pool, QueryResult, QueryResultRow } from 'pg';
import { config } from './config';
import { getRequestId } from './context';

export const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

const SLOW_QUERY_THRESHOLD_MS = 200;

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration_ms = Date.now() - start;

  if (duration_ms > SLOW_QUERY_THRESHOLD_MS) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      request_id: getRequestId(),
      duration_ms,
      query: text,
      param_count: params?.length ?? 0,
    }));
  }

  return result;
}
