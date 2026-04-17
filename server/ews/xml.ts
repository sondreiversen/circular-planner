/**
 * EWS XML extraction helpers.
 *
 * EWS responses have a predictable SOAP structure — we extract the few fields
 * we need with targeted regex rather than pulling in an XML parser dependency.
 */

export interface RawCalendarItem {
  subject: string;
  start: string;       // ISO datetime from Exchange
  end: string;
  location: string;
  body: string;
  categories: string[];
  isAllDay: boolean;
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, m => ENTITY_MAP[m] || m);
}

function stripHtmlTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract the text content of a single element by local tag name. */
function extractElement(block: string, tag: string): string {
  // Match both t: and no-namespace variants
  const re = new RegExp(`<(?:t:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:t:)?${tag}>`, 'i');
  const m = re.exec(block);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

/** Extract all <t:String> values within a <t:Categories> block. */
function extractCategories(block: string): string[] {
  const catBlock = extractElement(block, 'Categories');
  if (!catBlock) return [];
  const results: string[] = [];
  const re = /<(?:t:)?String[^>]*>([\s\S]*?)<\/(?:t:)?String>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(catBlock)) !== null) {
    results.push(decodeXmlEntities(m[1].trim()));
  }
  return results;
}

/** Parse all CalendarItem blocks from an EWS FindItem response. */
export function extractCalendarItems(xml: string): { items: RawCalendarItem[]; errors: string[] } {
  const items: RawCalendarItem[] = [];
  const errors: string[] = [];

  // Split on CalendarItem boundaries
  const re = /<(?:t:)?CalendarItem[\s>]([\s\S]*?)<\/(?:t:)?CalendarItem>/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = re.exec(xml)) !== null) {
    index++;
    try {
      const block = match[1];
      const subject = extractElement(block, 'Subject');
      const start = extractElement(block, 'Start');
      const end = extractElement(block, 'End');

      if (!subject && !start) {
        errors.push(`Item ${index}: missing Subject and Start`);
        continue;
      }

      const rawBody = extractElement(block, 'Body');
      const body = stripHtmlTags(rawBody);
      const location = extractElement(block, 'Location');
      const categories = extractCategories(block);
      const isAllDayStr = extractElement(block, 'IsAllDayEvent');
      const isAllDay = isAllDayStr.toLowerCase() === 'true';

      items.push({ subject, start, end, location, body, categories, isAllDay });
    } catch (err) {
      errors.push(`Item ${index}: parse error — ${(err as Error).message}`);
    }
  }

  return { items, errors };
}

/** Extract a SOAP fault message, if present. */
export function extractFaultMessage(xml: string): string | null {
  const faultString = extractElement(xml, 'faultstring');
  if (faultString) return faultString;

  const messageText = extractElement(xml, 'MessageText');
  if (messageText) return messageText;

  const responseCode = extractElement(xml, 'ResponseCode');
  if (responseCode && responseCode !== 'NoError') return responseCode;

  return null;
}
