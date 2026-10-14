/**
 * Client-safe schedule types and formatting helpers.
 *
 * Kept separate from `matches.ts` (which is server-only and imports the Supabase
 * server client) so client components can import the types and formatters
 * without pulling server code into the browser bundle.
 */
/** Timezone used for every schedule boundary in the project. */
export const MATCH_TIMEZONE = "Asia/Riyadh";
/**
 * Monday..Sunday bounds of the week containing `date`, as YYYY-MM-DD.
 *
 * The arithmetic is UTC calendar maths on a date string that is already local
 * to the project timezone. Using local-time Date methods would move fixtures
 * near midnight across a day boundary, which is exactly the bug this avoids.
 */
export function getWeekBounds(date) {
    const [year, month, day] = date.split("-").map(Number);
    const anchor = new Date(Date.UTC(year, month - 1, day));
    // getUTCDay(): 0 = Sunday. The week starts on Monday, so Sunday has offset 6.
    const offsetFromMonday = (anchor.getUTCDay() + 6) % 7;
    const start = new Date(Date.UTC(year, month - 1, day - offsetFromMonday));
    const end = new Date(Date.UTC(year, month - 1, day - offsetFromMonday + 6));
    const format = (value) => `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
    return { weekStartDate: format(start), weekEndDate: format(end) };
}
/** Calendar date (YYYY-MM-DD) for a moment, in the project timezone. */
export function getScheduleDate(date = new Date(), timeZone = MATCH_TIMEZONE) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
}
/** Calendar date immediately after `date` (YYYY-MM-DD). */
export function getNextScheduleDate(date) {
    const [year, month, day] = date.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}
export function formatKickoffTime(kickoffTime, locale = "ar") {
    const [hours, minutes] = kickoffTime.split(":").map(Number);
    const anchor = new Date(Date.UTC(2000, 0, 1, hours, minutes));
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-SA" : "en-GB", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
    }).format(anchor);
}
export function formatMatchDate(matchDate, locale = "ar") {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-SA" : "en-GB", {
        dateStyle: "full",
        timeZone: "UTC",
    }).format(new Date(`${matchDate}T00:00:00Z`));
}
/** Offset of the project timezone, in minutes, at a given wall-clock time. */
function timeZoneOffsetMinutes(matchDate, kickoffTime) {
    const [year, month, day] = matchDate.split("-").map(Number);
    const [hours, minutes] = kickoffTime.split(":").map(Number);
    const guess = new Date(Date.UTC(year, month - 1, day, hours, minutes));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: MATCH_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(guess);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const asZoned = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour) % 24, Number(values.minute));
    return (asZoned - guess.getTime()) / 60_000;
}
/** ISO timestamp of the kickoff instant, derived from the stored date + time. */
export function getKickoffInstant(matchDate, kickoffTime) {
    const offset = timeZoneOffsetMinutes(matchDate, kickoffTime);
    const [year, month, day] = matchDate.split("-").map(Number);
    const [hours, minutes] = kickoffTime.split(":").map(Number);
    return new Date(Date.UTC(year, month - 1, day, hours, minutes) - offset * 60_000).toISOString();
}
