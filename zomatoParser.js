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

// A Zomato order email typically carries multiple PDFs:
//  - "Order Summary and Receipt" — what the customer actually paid, i.e. after
//    any personal discount coupons and Gold/free-delivery perks are applied.
//  - The restaurant's GST "Tax Invoice" — the invoice value for the food
//    items (+ packaging), independent of any personal coupon the customer
//    used. This is the amount that should be claimed for reimbursement.
//  - Zomato's own "User Charge Invoice" — a tax invoice for the platform fee
//    only (a few rupees). Not a reimbursable bill on its own.
// These have different layouts, so each needs its own field extraction.
function classifyZomatoDocument(text) {
  if (/Order\s*Time\s*:/i.test(text)) return 'order_summary';
  if (/Tax\s*Invoice/i.test(text) && /Restaurant\s*Name\s*:/i.test(text)) return 'restaurant_invoice';
  if (/Tax\s*Invoice/i.test(text)) return 'platform_invoice';
  return 'unknown';
}

function parseOrderSummaryDate(text) {
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

function parseInvoiceDate(text) {
  // Most reliable: "... settled digitally against Order ID 123 dated 2026-09-11."
  const settled = text.match(/dated\s*\(?\s*(\d{4})-(\d{2})-(\d{2})\)?/i);
  if (settled) {
    const [, year, month, day] = settled;
    return `${year}-${pad(Number(month))}-${pad(Number(day))}`;
  }

  // Fallback: "Invoice Date: 11/09/2026" (DD/MM/YYYY).
  const invoiceDate = text.match(/Invoice\s*Date\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (invoiceDate) {
    const [, day, month, year] = invoiceDate;
    return `${year}-${pad(Number(month))}-${pad(Number(day))}`;
  }

  return null;
}

function parseRestaurantName(text) {
  const match = text.match(/Restaurant\s*Name\s*:\s*(.+)/i);
  if (!match) return 'Zomato';
  const name = match[1].replace(/\s+/g, ' ').trim();
  return name || 'Zomato';
}

function parseOrderSummaryAmount(text) {
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

function parseInvoiceAmount(text) {
  // Most reliable: "Amount of INR 222.60 settled digitally against Order ID ..."
  // or "Amount of ₹17.688 settled through digital mode/payment received against ..."
  const settled = text.match(/Amount\s+of\s+(?:INR|₹|Rs\.?)\s*([\d,]+\.?\d*)\s+settled/i);
  if (settled) {
    const amount = parseAmountToken(settled[1]);
    if (amount != null) return amount;
  }

  // Fallback: the last number on the "Total Value ..." row (the grand total
  // column), since that row also contains gross/discount/tax sub-amounts.
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (/^Total\s*Value\b/i.test(line)) {
      const numbers = line.match(/[\d,]+\.\d{2}/g);
      if (numbers && numbers.length) {
        const amount = parseAmountToken(numbers[numbers.length - 1]);
        if (amount != null) return amount;
      }
    }
  }
  return null;
}

function parseOrderId(text) {
  // Handles "Order ID: 123", "against Order ID 123 dated", and
  // "against Order id (123) dated" — all seen across the different PDFs.
  const match = text.match(/Order\s*id\s*[:(]?\s*(\d{4,})/i);
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
 * Parse a Zomato PDF buffer (order summary or restaurant tax invoice) into
 * bill fields.
 * @returns {{ date: string, amount: number, merchant: string, orderId: string|null, documentType: string }}
 */
async function parseZomatoReceipt(buffer) {
  const text = await extractPdfText(buffer);
  if (!/zomato/i.test(text)) {
    const err = new Error('This does not look like a Zomato receipt PDF.');
    err.code = 'NOT_ZOMATO';
    throw err;
  }

  const documentType = classifyZomatoDocument(text);

  if (documentType === 'platform_invoice') {
    const err = new Error('This is Zomato\'s platform-fee invoice, not a reimbursable food bill.');
    err.code = 'NOT_REIMBURSABLE';
    throw err;
  }
  if (documentType === 'unknown') {
    const err = new Error('This does not look like a Zomato order summary or tax invoice PDF.');
    err.code = 'NOT_ZOMATO';
    throw err;
  }

  const isInvoice = documentType === 'restaurant_invoice';
  const date = isInvoice ? parseInvoiceDate(text) : parseOrderSummaryDate(text);
  const amount = isInvoice ? parseInvoiceAmount(text) : parseOrderSummaryAmount(text);
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
    documentType: isInvoice ? 'invoice' : 'order_summary',
  };
}

module.exports = {
  parseZomatoReceipt,
  classifyZomatoDocument,
  parseOrderSummaryDate,
  parseInvoiceDate,
  parseOrderSummaryAmount,
  parseInvoiceAmount,
  parseRestaurantName,
  parseOrderId,
};
