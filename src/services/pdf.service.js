const PDFDocument = require('pdfkit');

const BRAND_COLOR = '#0E2230';
const ACCENT_COLOR = '#FFB020';

function money(amount, currency = 'NGN') {
  const symbol = currency === 'NGN' ? '₦' : currency + ' ';
  return `${symbol}${parseFloat(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Streams a single-transaction receipt PDF into the given writable stream (e.g. res). */
function generateReceipt(txn, wallet, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 90).fill(BRAND_COLOR);
  doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold').text('OffPay', 50, 30);
  doc.fontSize(10).font('Helvetica').text('Payment Receipt', 50, 58);

  doc.fillColor('#000000').moveDown(4);
  doc.fontSize(12).font('Helvetica-Bold').text('Transaction Summary', 50, 120);
  doc.moveTo(50, 138).lineTo(545, 138).strokeColor('#DDDDDD').stroke();

  const rows = [
    ['Reference', txn.reference],
    ['Date', new Date(txn.created_at).toLocaleString('en-NG')],
    ['Type', txn.type.replace(/_/g, ' ').toUpperCase()],
    ['Direction', txn.direction.toUpperCase()],
    ['Amount', money(txn.amount, wallet.currency)],
    ['Fee', money(txn.fee, wallet.currency)],
    ['Status', txn.status.toUpperCase()],
  ];
  if (txn.counterparty_name) rows.push(['Counterparty', txn.counterparty_name]);
  if (txn.counterparty_bank) rows.push(['Counterparty Bank', txn.counterparty_bank]);
  if (txn.counterparty_number) rows.push(['Counterparty Account', txn.counterparty_number]);
  if (txn.narration) rows.push(['Narration', txn.narration]);

  let y = 150;
  doc.fontSize(10);
  rows.forEach(([label, value], i) => {
    if (i % 2 === 0) doc.rect(50, y - 4, 495, 22).fill('#F7F8FA').fillColor('#000000');
    doc.fillColor('#5B6472').font('Helvetica').text(label, 60, y);
    doc.fillColor('#0E2230').font('Helvetica-Bold').text(String(value), 250, y);
    y += 22;
  });

  doc.rect(50, y + 10, 495, 1).fill('#DDDDDD');
  doc.fillColor('#5B6472').fontSize(9).font('Helvetica')
    .text('This is an electronically generated receipt and does not require a signature.', 50, y + 25)
    .text('OffPay is a product of OffPay Technologies Ltd. Licensed and regulated for digital wallet services in Nigeria.', 50, y + 40)
    .text('Need help with this transaction? Contact support@offpay.app', 50, y + 55);

  doc.end();
}

/** Streams an account statement PDF (date-ranged transaction list) into the given writable stream. */
function generateStatement({ user, wallet, transactions, from, to }, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 90).fill(BRAND_COLOR);
  doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold').text('OffPay', 40, 28);
  doc.fontSize(10).font('Helvetica').text('Account Statement', 40, 56);

  doc.fillColor('#000000').fontSize(10).font('Helvetica');
  doc.text(`Account Holder: ${user.full_name}`, 40, 105);
  doc.text(`Address: ${user.address || 'Not yet provided — add one in Settings'}`, 40, 120, { width: 260 });
  doc.text(`Wallet ID: ${wallet.wallet_id}`, 40, 150);
  doc.text(`Account Number: ${wallet.virtual_account || 'N/A'} (${wallet.virtual_bank || 'N/A'})`, 40, 165);
  doc.text(`Statement Period: ${from} to ${to}`, 40, 180);
  doc.text(`Closing Balance: ${money(wallet.balance, wallet.currency)}`, 350, 105);
  doc.text(`Generated: ${new Date().toLocaleString('en-NG')}`, 350, 120);

  // Balance before/after is intentionally shown here (and only here) —
  // a statement of account is a personal ledger the user downloads for
  // their own records, unlike the single-transaction receipt above, which
  // is routinely shared with third parties and shouldn't expose wallet
  // balances.
  let y = 210;
  doc.font('Helvetica-Bold').fontSize(8);
  doc.rect(40, y - 5, 515, 20).fill(ACCENT_COLOR);
  doc.fillColor('#0E2230');
  doc.text('Date', 45, y);
  doc.text('Reference', 110, y);
  doc.text('Type', 210, y);
  doc.text('Amount', 285, y);
  doc.text('Fee', 340, y);
  doc.text('Bal. before', 385, y);
  doc.text('Bal. after', 450, y);
  y += 22;

  doc.font('Helvetica').fontSize(7.5);
  transactions.forEach((t, i) => {
    if (y > 760) { doc.addPage(); y = 40; }
    if (i % 2 === 0) doc.rect(40, y - 4, 515, 18).fill('#F7F8FA');
    doc.fillColor('#333333');
    doc.text(new Date(t.created_at).toLocaleDateString('en-NG'), 45, y);
    doc.text(t.reference, 110, y, { width: 95, ellipsis: true });
    doc.text(t.type.replace(/_/g, ' '), 210, y, { width: 70 });
    doc.fillColor(t.direction === 'credit' ? '#1F9D74' : '#C0392B');
    doc.text(`${t.direction === 'credit' ? '+' : '-'}${money(t.amount, wallet.currency)}`, 285, y, { width: 50 });
    doc.fillColor('#333333');
    doc.text(money(t.fee, wallet.currency), 340, y, { width: 40 });
    doc.text(money(t.balance_before, wallet.currency), 385, y, { width: 60 });
    doc.text(money(t.balance_after, wallet.currency), 450, y, { width: 60 });
    y += 18;
  });

  doc.end();
}

module.exports = { generateReceipt, generateStatement };
