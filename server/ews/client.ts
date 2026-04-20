/**
 * EWS (Exchange Web Services) client.
 *
 * Fetches calendar events from an on-premises Exchange server using SOAP/XML.
 * Supports NTLMv2 and Basic authentication. No external dependencies.
 *
 * Resilience features:
 * - retryWithBackoff(): up to 3 attempts, delays 1s/3s/8s. Retries on transient
 *   errors (timeout, 5xx, network). Does NOT retry authoritative errors (401
 *   after successful NTLM handshake, 4xx non-429, invalid credentials).
 * - fetchCalendarEvents() splits the date range into monthly chunks (pages).
 *   Each chunk is fetched independently with retry. The caller receives progress
 *   callbacks so that completed pages are never re-fetched even if a later page
 *   fails and the user retries.
 */
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { createType1Message, parseType2Message, createType3Message, parseCredentials } from './ntlm';
import { extractCalendarItems, extractFaultMessage, type RawCalendarItem } from './xml';

export interface EwsConfig {
  serverUrl: string;       // e.g. "https://mail.corp.com/ews/exchange.asmx"
  username: string;        // e.g. "DOMAIN\\user" or "user@domain.com"
  password: string;
  authMethod: 'ntlm' | 'basic';
  allowSelfSignedCert?: boolean;
}

export interface EwsCalendarQuery {
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
  maxItems?: number;   // default 500
}

export interface ImportedEvent {
  subject: string;
  description: string;
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
  location: string;
  categories: string[];
  isAllDay: boolean;
}

export interface FetchProgressCallback {
  (completed: number, total: number, lastError?: string): void;
}

/** Per-attempt timeout. Each of the ≤3 attempts gets this budget. */
const REQUEST_TIMEOUT = 30_000;

/** Retry delays between attempts (ms). Up to 3 retries = 4 total attempts max. */
const RETRY_DELAYS = [1_000, 3_000, 8_000];

/**
 * Returns true for errors that may succeed on retry (transient):
 * network errors, timeouts, HTTP 429, HTTP 5xx.
 * Returns false for authoritative errors that will not benefit from retry.
 */
function isTransientError(err: Error): boolean {
  const msg = err.message;
  // Network-level
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up/i.test(msg)) return true;
  // Our own timeout
  if (/timed out/i.test(msg)) return true;
  // HTTP 5xx
  if (/HTTP 5\d\d/.test(msg)) return true;
  // HTTP 429
  if (/HTTP 429/.test(msg)) return true;
  // NTLM negotiate step failed (not auth, just comms)
  if (/NTLM negotiate failed: expected 401, got 5/i.test(msg)) return true;
  // Authoritative — do NOT retry
  // 401 after successful NTLM handshake, invalid credentials, 4xx
  return false;
}

/**
 * Retry wrapper. Calls fn() up to (1 + RETRY_DELAYS.length) times.
 * Waits RETRY_DELAYS[attempt] ms between retries.
 * Only retries if isTransientError() is true.
 */
async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: Error = new Error('Unknown error');
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      const isLast = attempt === RETRY_DELAYS.length;
      if (isLast || !isTransientError(lastErr)) {
        throw lastErr;
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
  throw lastErr;
}

function escapeXmlAttr(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
}

function buildSoapEnvelope(query: EwsCalendarQuery): string {
  const max = query.maxItems || 500;
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:Body"/>
          <t:FieldURI FieldURI="calendar:Start"/>
          <t:FieldURI FieldURI="calendar:End"/>
          <t:FieldURI FieldURI="calendar:Location"/>
          <t:FieldURI FieldURI="item:Categories"/>
          <t:FieldURI FieldURI="calendar:IsAllDayEvent"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:CalendarView StartDate="${escapeXmlAttr(query.startDate)}T00:00:00Z" EndDate="${escapeXmlAttr(query.endDate)}T23:59:59Z" MaxEntriesReturned="${max}"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="calendar"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;
}

/** Make a single HTTPS request. Returns { statusCode, headers, body }. */
function request(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  agent: https.Agent,
  timeout: number,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: { ...headers, 'Host': url.hostname },
      agent,
      timeout,
    };

    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function fetchWithNtlm(
  url: URL,
  soapBody: string,
  config: EwsConfig,
): Promise<string> {
  const creds = parseCredentials(config.username, config.password);
  const agent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: !config.allowSelfSignedCert,
  });

  try {
    // Step 1: Send Type 1 (Negotiate) — each round-trip gets its own timeout budget
    const type1 = createType1Message(creds.domain);
    const res1 = await request(url, 'POST', {
      'Content-Type': 'text/xml; charset=utf-8',
      'Authorization': `NTLM ${type1}`,
      'Content-Length': '0',
    }, null, agent, REQUEST_TIMEOUT);

    if (res1.statusCode !== 401) {
      throw new Error(`NTLM negotiate failed: expected 401, got ${res1.statusCode}`);
    }

    // Step 2: Parse Type 2 (Challenge)
    const wwwAuth = res1.headers['www-authenticate'];
    if (!wwwAuth) {
      throw new Error('Server did not return WWW-Authenticate header for NTLM challenge');
    }

    const ntlmMatch = /NTLM\s+(\S+)/i.exec(
      Array.isArray(wwwAuth) ? wwwAuth.find(h => /NTLM/i.test(h)) || '' : wwwAuth
    );
    if (!ntlmMatch) {
      throw new Error('Server did not return NTLM challenge — NTLM may not be enabled');
    }

    const type2 = parseType2Message(ntlmMatch[1]);

    // Step 3: Send Type 3 (Authenticate) with the actual SOAP body
    const type3 = createType3Message(creds, type2);
    const res3 = await request(url, 'POST', {
      'Content-Type': 'text/xml; charset=utf-8',
      'Authorization': `NTLM ${type3}`,
      'Content-Length': String(Buffer.byteLength(soapBody)),
    }, soapBody, agent, REQUEST_TIMEOUT);

    if (res3.statusCode === 401) {
      // Authoritative auth failure — do NOT retry
      throw new Error('NTLM authentication failed — check username, password, and domain');
    }

    if (res3.statusCode !== 200) {
      throw new Error(`EWS returned HTTP ${res3.statusCode}: ${res3.body.substring(0, 200)}`);
    }

    return res3.body;
  } finally {
    agent.destroy();
  }
}

async function fetchWithBasic(
  url: URL,
  soapBody: string,
  config: EwsConfig,
): Promise<string> {
  const agent = new https.Agent({
    rejectUnauthorized: !config.allowSelfSignedCert,
  });

  try {
    const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    const res = await request(url, 'POST', {
      'Content-Type': 'text/xml; charset=utf-8',
      'Authorization': `Basic ${auth}`,
      'Content-Length': String(Buffer.byteLength(soapBody)),
    }, soapBody, agent, REQUEST_TIMEOUT);

    if (res.statusCode === 401) {
      throw new Error('Basic authentication failed — check username and password');
    }

    if (res.statusCode !== 200) {
      throw new Error(`EWS returned HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
    }

    return res.body;
  } finally {
    agent.destroy();
  }
}

/** Convert Exchange ISO datetime to YYYY-MM-DD. */
function toDateStr(isoStr: string): string {
  if (!isoStr) return '';
  // Handle "2026-04-15T09:00:00Z" or "2026-04-15T09:00:00+02:00"
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr.substring(0, 10);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mapItem(raw: RawCalendarItem): ImportedEvent {
  let startDate = toDateStr(raw.start);
  let endDate = toDateStr(raw.end);

  // All-day events: Exchange uses exclusive end (e.g. Start=Apr15, End=Apr16 for a 1-day event).
  // Subtract one day from end to make it inclusive.
  if (raw.isAllDay && endDate > startDate) {
    const d = new Date(endDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    endDate = toDateStr(d.toISOString());
  }

  // For same-day timed events, ensure endDate >= startDate
  if (endDate < startDate) {
    endDate = startDate;
  }

  let description = raw.body;
  if (raw.location) {
    description = description ? `Location: ${raw.location}\n\n${description}` : `Location: ${raw.location}`;
  }

  return {
    subject: raw.subject.substring(0, 200),
    description: description.substring(0, 2000),
    startDate,
    endDate,
    location: raw.location,
    categories: raw.categories,
    isAllDay: raw.isAllDay,
  };
}

/**
 * Build an array of monthly date-range chunks covering [startDate, endDate].
 * Each chunk is { startDate, endDate } (YYYY-MM-DD, both inclusive).
 */
function buildMonthlyChunks(startDate: string, endDate: string): Array<{ startDate: string; endDate: string }> {
  const chunks: Array<{ startDate: string; endDate: string }> = [];
  let cursor = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (cursor <= end) {
    // Compute last day of this month
    const chunkStart = cursor.toISOString().substring(0, 10);
    const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const chunkEndDate = new Date(nextMonth.getTime() - 86_400_000); // last day of month
    const chunkEnd = (chunkEndDate <= end ? chunkEndDate : end).toISOString().substring(0, 10);
    chunks.push({ startDate: chunkStart, endDate: chunkEnd });
    cursor = nextMonth;
  }

  return chunks.length > 0 ? chunks : [{ startDate, endDate }];
}

/**
 * Fetch one page (date-range chunk) with retry + backoff.
 */
async function fetchPage(
  config: EwsConfig,
  chunk: { startDate: string; endDate: string },
  maxItems: number,
): Promise<{ items: RawCalendarItem[]; errors: string[] }> {
  return retryWithBackoff(async () => {
    const url = new URL(config.serverUrl);
    const soapBody = buildSoapEnvelope({ ...chunk, maxItems });

    let xmlResponse: string;
    if (config.authMethod === 'ntlm') {
      xmlResponse = await fetchWithNtlm(url, soapBody, config);
    } else {
      xmlResponse = await fetchWithBasic(url, soapBody, config);
    }

    const fault = extractFaultMessage(xmlResponse);
    if (fault) {
      throw new Error(`Exchange returned an error: ${fault}`);
    }

    return extractCalendarItems(xmlResponse);
  });
}

export async function fetchCalendarEvents(
  config: EwsConfig,
  query: EwsCalendarQuery,
  onProgress?: FetchProgressCallback,
): Promise<{ events: ImportedEvent[]; totalFound: number; errors: string[] }> {
  const maxItems = query.maxItems || 500;
  const chunks = buildMonthlyChunks(query.startDate, query.endDate);
  const allEvents: ImportedEvent[] = [];
  const allErrors: string[] = [];

  onProgress?.(0, chunks.length);

  for (let i = 0; i < chunks.length; i++) {
    const { items, errors } = await fetchPage(config, chunks[i], maxItems);
    allEvents.push(...items.map(mapItem));
    allErrors.push(...errors);
    onProgress?.(i + 1, chunks.length);
  }

  return { events: allEvents, totalFound: allEvents.length, errors: allErrors };
}
