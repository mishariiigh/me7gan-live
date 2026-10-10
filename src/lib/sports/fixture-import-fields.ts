/**
 * Column-field descriptors shared by the server-side parser and the admin UI.
 *
 * This module is deliberately free of any `server-only` dependency (and of the
 * spreadsheet parser) so the client component can import the field list and its
 * labels without pulling Node-only code into the browser bundle.
 */

export type FieldName = "matchDate" | "kickoffTime" | "competition" | "homeTeam" | "awayTeam" | "key";

/** Column headings a user might see, in the order the UI shows them. */
export const FIELD_LABELS: Record<FieldName, string> = {
  matchDate: "التاريخ / Date",
  kickoffTime: "وقت البداية / Kick-off",
  competition: "البطولة / Competition",
  homeTeam: "الفريق المضيف / Home team",
  awayTeam: "الفريق الضيف / Away team",
  key: "معرّف المباراة / Match ID (اختياري)",
};

/** Fields that must be mapped; `key` is optional. */
export const REQUIRED_FIELDS: FieldName[] = ["matchDate", "kickoffTime", "competition", "homeTeam", "awayTeam"];
