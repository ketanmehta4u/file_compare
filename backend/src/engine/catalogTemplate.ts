import ExcelJS from "exceljs";

/** Port of comparison.py's _TEMPLATE_DTYPES: the dtype hints a catalogue
 * may declare, with plain-language meaning and example values. Kept next
 * to the template builder so it can never drift from what loadCatalog
 * actually accepts. */
const TEMPLATE_DTYPES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "text",
    "Compared as text. Case sensitivity and whitespace trimming follow the comparison settings.",
    "INV-00042  |  Acme Corp  |  4500 (kept as text if the column is ids)",
  ],
  [
    "numeric",
    "Compared with exact decimal math — never floating point. 1200, 1200.00 and 1,200 are all the same number.",
    "1200  |  1,200.00  |  -15.25",
  ],
  [
    "money",
    "Numeric plus currency handling: the symbols $ € £ ¥ ₹ ₽ ₩ ₪ and thousands separators are stripped, and accounting negatives in parentheses are understood: (2,500.00) equals -2500.00.",
    "$1,234.56  |  (2,500.00)  |  €99.00",
  ],
  [
    "date",
    "Parsed into a real date before comparing, so different spellings of the same day are equal. Excel date cells and serial numbers also work. Timestamps are accepted but compared at DAY precision — the time of day is ignored (use the enforced 'timestamp' type when it must match).",
    "2026-01-31  |  31/01/2026  |  Jan 31, 2026  |  2026-01-31 09:00:00",
  ],
  [
    "id (ENFORCED)",
    "Strict text — the column is never coerced to a number or date, so leading zeros and formatting are significant: '00123' does NOT equal '123'. Use for account codes, invoice numbers, and any identifier that merely looks numeric.",
    "00123  |  0004567  |  INV-001",
  ],
  [
    "timestamp (ENFORCED)",
    "Full date-time precision — unlike 'date', the time of day participates: 2026-01-31 09:00 does NOT equal 2026-01-31 17:30. A date with no time counts as midnight.",
    "2026-01-31 09:00:00  |  2026-01-31T09:00:00  |  Excel datetime cells",
  ],
];

/** Port of comparison.py's _TEMPLATE_GOTCHAS. */
const TEMPLATE_GOTCHAS: ReadonlyArray<readonly [string, string]> = [
  [
    "Timestamps",
    "In a normal date column, a date-plus-time value matches on the date only: 2026-01-31 09:00 and 2026-01-31 17:30 compare as EQUAL. Declare dtype 'timestamp' on the column when the time of day must match exactly.",
  ],
  [
    "Booleans",
    "TRUE/FALSE have no special handling — they compare as text, so 'TRUE' vs 'true' is a difference unless case sensitivity is switched off. Keep the casing consistent across both files.",
  ],
  [
    "Percentages",
    "The % sign is not parsed: '10%' is text, and it will never equal the number 0.10. Store plain numbers (0.10) in both files.",
  ],
  [
    "Ids with leading zeros",
    "By default, any value that LOOKS numeric is compared as a number: '00123' equals '123'. Declare dtype 'id' on the column to compare it strictly as text and make leading zeros significant.",
  ],
  [
    "Times without a date",
    "A bare time like '09:30' is compared as text (never coerced to a date), so '09:30' vs '17:45' is correctly flagged as a difference.",
  ],
];

const TEMPLATE_DATASETS_HEADER = [
  "dataset_id",
  "dataset_name",
  "owner",
  "source_system",
  "frequency",
  "numeric_tolerance",
  "case_sensitive",
  "trim_whitespace",
  "treat_blank_as_zero",
  "description",
];

const TEMPLATE_COLUMNS_HEADER = [
  "dataset_id",
  "canonical_name",
  "source_column",
  "key_role",
  "dtype",
  "description",
];

/** Port of comparison.py's _TEMPLATE_COLUMN_ROWS: one example row per
 * supported dtype, plus a key, so a user sees every concept before
 * replacing the rows. */
const TEMPLATE_COLUMN_ROWS: ReadonlyArray<readonly string[]> = [
  [
    "MY_DATASET",
    "record_id",
    "id",
    "primary",
    "text",
    "Unique row identifier — the join key. 'source_column' says the source file calls it 'id'; the target must already use 'record_id'.",
  ],
  [
    "MY_DATASET",
    "trade_date",
    "",
    "",
    "date",
    "Blank source_column = the source file already uses this name. Any common date format works: 2026-01-31, 31/01/2026, Jan 31 2026.",
  ],
  [
    "MY_DATASET",
    "amount",
    "amt",
    "",
    "money",
    "Currency symbols, thousands separators and (parentheses) negatives are all handled: $1,234.56 and 1234.56 are equal.",
  ],
  ["MY_DATASET", "quantity", "", "", "numeric", "Plain number — compared with exact decimal math."],
  [
    "MY_DATASET",
    "counterparty",
    "",
    "",
    "text",
    "Free text. Case and whitespace sensitivity are comparison settings.",
  ],
  [
    "MY_DATASET",
    "account_code",
    "",
    "",
    "id",
    "ENFORCED strict text: never coerced to a number, so leading zeros are significant — '00123' does not equal '123'.",
  ],
  [
    "MY_DATASET",
    "updated_at",
    "",
    "",
    "timestamp",
    "ENFORCED full date-time precision: 2026-01-31 09:00 does not equal 2026-01-31 17:30 (a plain 'date' column would treat them as equal).",
  ],
];

/** Port of comparison.py's _TEMPLATE_HOWTO_ROWS. */
const TEMPLATE_HOWTO_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["CATALOGUE TEMPLATE — HOW TO USE", ""],
  ["", ""],
  [
    "What this file is",
    "A catalogue tells the comparison tool how your two files line up: what each dataset is, which columns to compare, which column(s) form the matching key, and what settings to default to.",
  ],
  ["", ""],
  [
    "Step 1",
    "On the 'Datasets' sheet, describe each dataset (one row each). Only dataset_id is required; the settings columns pre-fill the app's options when the dataset is selected.",
  ],
  [
    "Step 2",
    "On the 'Columns' sheet, list every column to compare (one row per column). Required: dataset_id and canonical_name. Use source_column when the source file names it differently — the target file is expected to already use the canonical name.",
  ],
  [
    "Step 3",
    "Delete the MY_DATASET example rows, save the file, and upload it in the app under 'Dataset catalogue'.",
  ],
  ["", ""],
  [
    "key_role",
    "Marks the matching key: 'primary' (single id), 'composite' (several columns together), or 'surrogate' (a system hash/id). When more than one role is present, surrogate beats composite beats primary. A plain 'is_key' column with y/yes/true/1 also works.",
  ],
  ["", ""],
  ["SUPPORTED DATA TYPES (dtype column)", ""],
  [
    "note",
    "text / numeric / money / date are documentation hints — the engine detects every cell's type automatically, so a wrong hint never breaks a comparison. 'id' and 'timestamp' are different: they are ENFORCED and change how the column is compared.",
  ],
  ...TEMPLATE_DTYPES.map(([name, meaning, examples]) => [name, `${meaning}  Examples: ${examples}`] as const),
  ["", ""],
  [
    "Blank cells",
    "A blank is treated as 'missing', which is different from 0. The 'treat blank as zero' setting changes that for numeric columns.",
  ],
  ["", ""],
  ["GOOD TO KNOW (other value kinds)", ""],
  ...TEMPLATE_GOTCHAS,
];

/**
 * Port of comparison.py's `build_catalog_template`. Three sheets: 'How to
 * use', 'Datasets' and 'Columns' pre-filled with one example dataset
 * covering every dtype and a key. Guaranteed to round-trip through
 * loadCatalog unedited (verified by a test).
 */
export async function buildCatalogTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const howto = wb.addWorksheet("How to use");
  for (const [label, text] of TEMPLATE_HOWTO_ROWS) {
    const row = howto.addRow([label, text]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  howto.getColumn(1).width = 34;
  howto.getColumn(2).width = 100;

  const ds = wb.addWorksheet("Datasets");
  ds.addRow(TEMPLATE_DATASETS_HEADER);
  ds.addRow([
    "MY_DATASET",
    "Example dataset — replace me",
    "Your team",
    "Source system name",
    "monthly",
    "0.01",
    "Y",
    "Y",
    "N",
    "Example: daily trades reconciled against the ledger. numeric_tolerance/case_sensitive/trim_whitespace/treat_blank_as_zero become the app's default settings for this dataset.",
  ]);

  const cols = wb.addWorksheet("Columns");
  cols.addRow(TEMPLATE_COLUMNS_HEADER);
  for (const row of TEMPLATE_COLUMN_ROWS) cols.addRow(row);

  for (const sheet of [ds, cols]) {
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true };
      const width = Math.max(16, Math.min(46, String(cell.value ?? "").length + 8));
      sheet.getColumn(cell.col).width = width;
    });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
