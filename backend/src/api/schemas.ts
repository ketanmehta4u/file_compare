import { z } from "zod";

/**
 * Runtime shapes for request bodies.
 *
 * The DTOs in dto.ts are TypeScript interfaces: they vanish at runtime, so
 * `req.body as CompareRequest` checked nothing at all. Measured against the
 * running server, that let a caller send `case_sensitive: "yes"` or
 * `decimal_precision: "abc"` and get back a *reconciliation result* computed
 * with the setting silently ignored, while `key_columns: "id"` produced a
 * 500 and an unhandled-error log line. On financial data, quietly comparing
 * differently from what was asked is the worst of those outcomes.
 *
 * These schemas are the one place the wire contract is enforced. A failure
 * becomes a 400 naming the field (see api/errors.ts).
 */

/** Ceilings so an absurd body inside the 1 MB JSON limit cannot make absurd
 * work: a real file has hundreds of columns, not hundreds of thousands. */
const MAX_MAPPED_COLUMNS = 4096;
const MAX_SELECTED_COLUMNS = 1024;

const columnName = z.string().min(1).max(512);
const id = z.string().min(1).max(128);

/**
 * Strict: an unknown field is rejected rather than ignored. A typo like
 * `key_column` would otherwise be dropped in silence and the comparison
 * would run with a setting the caller believed they had set -- exactly the
 * failure this file exists to stop. The UI sends these fields and no others.
 */
export const compareRequestSchema = z.strictObject({
  source_file_id: id,
  target_file_id: id,
  catalog_id: id.nullish(),
  dataset_id: id.nullish(),
  column_map: z
    .record(columnName, columnName)
    .refine((m) => Object.keys(m).length <= MAX_MAPPED_COLUMNS, {
      message: `too many mapped columns (limit ${MAX_MAPPED_COLUMNS})`,
    })
    .optional(),
  drop_unmapped: z.boolean().optional(),
  key_columns: z.array(columnName).max(MAX_SELECTED_COLUMNS).optional(),
  case_sensitive: z.boolean().optional(),
  trim_whitespace: z.boolean().optional(),
  // Left as a string: parseTolerance() in the compare route turns it into a
  // Decimal and already answers 400 with a message naming the value.
  numeric_tolerance: z.string().max(64).optional(),
  decimal_precision: z.number().int().min(0).max(100).nullish(),
  treat_blank_as_zero: z.boolean().optional(),
  fuzzy_column_names: z.boolean().optional(),
  control_total_columns: z.array(columnName).max(MAX_SELECTED_COLUMNS).optional(),
  // Values are checked against 'id'/'timestamp' in the route, which reports
  // the offending column by name.
  enforced_dtypes: z.record(columnName, z.string().max(64)).optional(),
  annotated_outputs: z.boolean().optional(),
});

/**
 * The text fields multer puts beside an uploaded file. Deliberately NOT
 * strict: a multipart form is assembled by the browser and may carry extra
 * parts, and rejecting an upload after its bytes have already crossed the
 * wire is a poor trade. Unknown fields are ignored; the ones we read are
 * type-checked.
 */
export const uploadOptionsSchema = z.object({
  sheet_name: z.string().max(255).optional(),
  has_header: z.string().max(8).optional(),
  delimiter: z.string().min(1).max(4).optional(),
});
