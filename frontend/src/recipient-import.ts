import Papa from 'papaparse';

const emailAddress = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const emailHeader = /^(e-?mail|recipient|recipients|email address)$/i;

export type RecipientImport = {
  recipients: string[];
  invalid: string[];
};

export function parseRecipientCsv(contents: string): RecipientImport {
  const parsed = Papa.parse<string[]>(contents, { skipEmptyLines: true });
  const rows = parsed.data;
  const header = rows[0];
  const emailColumns = header?.flatMap((cell, index) => emailHeader.test(cell.trim()) ? [index] : []);
  if (emailColumns?.length) rows.shift();

  const recipients = new Set<string>();
  const invalid = new Set<string>();
  for (const row of rows) {
    const cells = emailColumns?.length ? emailColumns.map((index) => row[index] || '') : row;
    for (const cell of cells) {
      for (const candidate of cell.split(/[;\s]+/).map((value) => value.trim()).filter(Boolean)) {
        const normalized = candidate.toLowerCase();
        if (emailAddress.test(normalized)) recipients.add(normalized);
        else invalid.add(candidate);
      }
    }
  }

  return { recipients: [...recipients], invalid: [...invalid] };
}
