import { Component, Input } from "@angular/core";

interface DtypeRow {
  name: string;
  meaning: string;
  examples: string;
}

/** Static collapsible guide -- port of the original's HowToUse.tsx. Content
 * kept in step with backend/src/engine/catalogTemplate.ts's dtype/gotcha
 * copy, same as the original kept its guide in sync with comparison.py's
 * template docs. */
@Component({
  selector: "app-how-to-use",
  templateUrl: "./how-to-use.component.html",
})
export class HowToUseComponent {
  @Input() maxUploadBytes: number | null = null;

  open = false;

  readonly dtypes: DtypeRow[] = [
    { name: "text", meaning: "Compared as text. Case sensitivity and whitespace trimming follow the comparison settings.", examples: "INV-00042 | Acme Corp | 4500 (kept as text if the column is ids)" },
    { name: "numeric", meaning: "Compared with exact decimal math — never floating point.", examples: "1200 | 1,200.00 | -15.25" },
    { name: "money", meaning: "Numeric plus currency handling: symbols and thousands separators are stripped; accounting negatives in parentheses are understood.", examples: "$1,234.56 | (2,500.00) | €99.00" },
    { name: "date", meaning: "Parsed into a real date before comparing. Timestamps are accepted but compared at DAY precision.", examples: "2026-01-31 | 31/01/2026 | Jan 31, 2026" },
    { name: "id (ENFORCED)", meaning: "Strict text — never coerced to a number, so leading zeros are significant.", examples: "00123 | 0004567 | INV-001" },
    { name: "timestamp (ENFORCED)", meaning: "Full date-time precision — the time of day participates in the comparison.", examples: "2026-01-31 09:00:00" },
  ];

  readonly gotchas: DtypeRow[] = [
    { name: "Timestamps", meaning: "A date-plus-time value matches on the date only by default; declare dtype 'timestamp' when the time must match exactly.", examples: "" },
    { name: "Booleans", meaning: "TRUE/FALSE compare as text — 'TRUE' vs 'true' is a difference unless case sensitivity is off.", examples: "" },
    { name: "Percentages", meaning: "The % sign is not parsed: '10%' is text and never equals 0.10.", examples: "" },
    { name: "Ids with leading zeros", meaning: "By default a numeric-looking value is compared as a number: '00123' equals '123'. Declare dtype 'id' to make leading zeros significant.", examples: "" },
    { name: "Times without a date", meaning: "A bare time like '09:30' is compared as text, never coerced to a date.", examples: "" },
  ];

  toggle(): void {
    this.open = !this.open;
  }
}
