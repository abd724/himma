/**
 * RI-6 — the canonical platform/venue timezone (IANA name; mirrors the
 * structural `recurring_schedule` CHECK pinning 'Asia/Dubai'). Customer
 * projections attach it to instant-bearing schedule fields so the app can
 * present venue-local civil dates/times truthfully on ANY device timezone
 * — the client never hardcodes an offset, and a future multi-zone
 * platform changes only the projected value. Storage stays UTC (docs/24
 * §6.13); this is presentation truth, never a second time authority.
 */
export const PLATFORM_TIMEZONE = 'Asia/Dubai';
