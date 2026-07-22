const { PDFParse } = require('pdf-parse');

const MONTH_LOOKUP = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseAmountToken(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/₹/g, '')
    .replace(/\bRs\.?/gi, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function parseOrderDate(text) {
  // Order Time: 22 July 2026, 11:58 AM
  const match = text.match(
    /Order\s*Time\s*:\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i
  );
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTH_LOOKUP[match[2].toLowerCase()];
  const year = Number(match[3]);
  if (!day || !month || !year) return null;
  if (day < 1 || day > 31) return null;

  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseRestaurantName(text) {
  const match = text.match(/Restaurant\s*Name\s*:\s*(.+)/i);
  if (!match) return 'Zomato';
  const name = match[1].replace(/\s+/g, ' ').trim();
  return name || 'Zomato';
}

function parseTotalAmount(text) {
  // Prefer the final "Total ₹272.43" line (not item total prices).
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const match = line.match(/^Total\s*[₹Rs.]?\s*([\d,]+\.?\d*)\s*$/i);
    if (match) {
      const amount = parseAmountToken(match[1]);
      if (amount != null) return amount;
    }
  }

  // Fallback: last Total occurrence anywhere in the text.
  const all = [...text.matchAll(/Total\s*[₹Rs.]?\s*([\d,]+\.?\d*)/gi)];
  if (all.length) {
    return parseAmountToken(all[all.length - 1][1]);
  }
  return null;
}

function parseOrderId(text) {
  const match = text.match(/Order\s*ID\s*:\s*(\d+)/i);
  return match ? match[1] : null;
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    if (typeof parser.destroy === 'function') {
      await parser.destroy();
    }
  }
}

/**
 * Parse a Zomato order-summary PDF buffer into bill fields.
 * @returns {{ date: string, amount: number, merchant: string, orderId: string|null }}
 */
async function parseZomatoReceipt(buffer) {
  const text = await extractPdfText(buffer);
  if (!/zomato/i.test(text)) {
    const err = new Error('This does not look like a Zomato receipt PDF.');
    err.code = 'NOT_ZOMATO';
    throw err;
  }

  const date = parseOrderDate(text);
  const amount = parseTotalAmount(text);
  const restaurant = parseRestaurantName(text);
  const orderId = parseOrderId(text);

  if (!date) {
    const err = new Error('Could not find the order date on the Zomato receipt.');
    err.code = 'PARSE_FAILED';
    throw err;
  }
  if (amount == null) {
    const err = new Error('Could not find the total amount on the Zomato receipt.');
    err.code = 'PARSE_FAILED';
    throw err;
  }

  return {
    date,
    amount,
    merchant: `Zomato - ${restaurant}`,
    orderId,
  };
}

module.exports = {
  parseZomatoReceipt,
  parseOrderDate,
  parseTotalAmount,
  parseRestaurantName,
};
