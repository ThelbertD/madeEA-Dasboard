/**
 * MadeEA funnel metrics: ads -> leads -> appointments.
 *
 * WHY THIS IS A SERVER ROUTE AND NOT BROWSER CODE
 * A GHL Private Integration token grants read access across the whole
 * sub-account: contacts, conversations, calendars, opportunities. Anything in
 * browser JavaScript is readable by anyone who opens DevTools, so the token
 * stays here, in a Vercel environment variable, and the browser only ever
 * receives counts. GHL's API also refuses cross-origin browser calls, so this
 * proxy is required either way.
 *
 * ENVIRONMENT VARIABLES (Vercel -> Settings -> Environment Variables)
 *   GHL_PRIVATE_TOKEN   the Private Integration token, starts "pit-"
 *   GHL_LOCATION_ID     the sub-account id
 *   DASHBOARD_KEY       a shared passphrase the dashboard must send. Without
 *                       it this route refuses to serve, because otherwise the
 *                       whole funnel's numbers are public to anyone with the
 *                       URL.
 *
 *   ALLOWED_ORIGINS     comma-separated origins allowed to call this route from
 *                       a browser. Needed because the dashboard is served from
 *                       GitHub Pages while this runs on Vercel. Defaults to
 *                       https://thelbertd.github.io.
 *
 * REQUIRED SCOPES on the Private Integration
 *   contacts.readonly, calendars.readonly, calendars/events.readonly
 *   locations.readonly is not needed.
 * Call this route with ?check=1 to have it report which scopes are working
 * rather than failing with an opaque 401.
 */

import { clientIp, createRateLimiter, jsonResponse } from './_shared.js';

export const maxDuration = 60;

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const REQUEST_TIMEOUT_MS = 15000;

/* GHL allows roughly 100 requests per 10 seconds per location. Pagination plus
   one events call per calendar can add up, so both are capped and spaced. */
const MAX_CONTACT_PAGES = 20;
const CONTACT_PAGE_SIZE = 100;
const REQUEST_SPACING_MS = 120;

const MAX_CONTACT_LOOKUPS = 60;

const MAX_RANGE_DAYS = 180;

/* Cheap protection against someone brute-forcing DASHBOARD_KEY. */
const isRateLimited = createRateLimiter(30, 60 * 1000);

/* ─────────────────────────── types ─────────────────────────── */

/* Field names confirmed against this location's live data. Note there is no
   `utmCampaign`: the campaign name arrives as `campaign`. */
interface Attribution {
  campaign?: string | null;
  campaignId?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmContent?: string | null;
  adSource?: string | null;
  adId?: string | null;
  sessionSource?: string | null;
  medium?: string | null;
  mediumId?: string | null;
  referrer?: string | null;
}

interface GhlContact {
  id?: string;
  dateAdded?: string;
  attributionSource?: Attribution | null;
  lastAttributionSource?: Attribution | null;
}

interface GhlEvent {
  id?: string;
  contactId?: string;
  startTime?: string | number;
  appointmentStatus?: string;
  status?: string;
}

interface DayRow {
  date: string;
  leads: number;
  appointments: number;
}

interface CampaignRow {
  campaign: string;
  leads: number;
  appointments: number;
}

/* ─────────────────────────── GHL client ─────────────────────────── */

/* Plain fields rather than TypeScript parameter properties, so the file can be
   run directly by Node's type stripping as well as compiled by Vercel. */
class GhlError extends Error {
  status: number;
  endpoint: string;

  constructor(message: string, status: number, endpoint: string) {
    super(message);
    this.name = 'GhlError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

function ghlHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function ghlFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${GHL_BASE}${path}`, {
      ...init,
      headers: ghlHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GhlError(
      err instanceof Error && err.name === 'TimeoutError'
        ? 'GHL did not respond in time'
        : 'Could not reach GHL',
      504,
      path,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    /* 401 means a bad token; 403 almost always means the scope was not ticked
       when the Private Integration was created. Saying which saves an hour. */
    const hint =
      res.status === 401
        ? 'GHL rejected the token. Check GHL_PRIVATE_TOKEN.'
        : res.status === 403
          ? `GHL refused this endpoint. The Private Integration is probably missing a scope for ${path}.`
          : `GHL returned ${res.status}.`;
    throw new GhlError(`${hint} ${body.slice(0, 300)}`.trim(), res.status, path);
  }

  return (await res.json()) as T;
}

/* ─────────────────────────── fetching ─────────────────────────── */

/**
 * Contacts created inside the window.
 *
 * GHL's search endpoint has changed shape more than once, so this asks for a
 * date-sorted page and stops walking as soon as it passes the start of the
 * window, rather than relying on a server-side date filter that may or may not
 * be honoured on a given account.
 */
async function fetchContacts(
  token: string,
  locationId: string,
  fromMs: number,
  toMs: number,
): Promise<GhlContact[]> {
  const collected: GhlContact[] = [];
  let page = 1;

  while (page <= MAX_CONTACT_PAGES) {
    const body = JSON.stringify({
      locationId,
      page,
      pageLimit: CONTACT_PAGE_SIZE,
      sort: [{ field: 'dateAdded', direction: 'desc' }],
    });

    const data = await ghlFetch<{ contacts?: GhlContact[]; total?: number }>(
      '/contacts/search',
      token,
      { method: 'POST', body },
    );

    const batch = data.contacts ?? [];
    if (batch.length === 0) break;

    let passedWindow = false;
    for (const c of batch) {
      const t = Date.parse(c.dateAdded ?? '');
      if (!Number.isFinite(t)) continue;
      if (t < fromMs) {
        passedWindow = true;
        continue;
      }
      if (t <= toMs) collected.push(c);
    }

    if (passedWindow || batch.length < CONTACT_PAGE_SIZE) break;
    page += 1;
    await sleep(REQUEST_SPACING_MS);
  }

  return collected;
}

/**
 * One contact by id.
 *
 * Needed because plenty of appointments are booked by people who became
 * contacts before the reporting window. Without this they have no campaign in
 * the map and land in "Unattributed", which on a real range produced a row
 * showing more appointments than leads.
 */
async function fetchContactById(
  token: string,
  contactId: string,
): Promise<GhlContact | null> {
  try {
    const data = await ghlFetch<{ contact?: GhlContact }>(
      `/contacts/${encodeURIComponent(contactId)}`,
      token,
    );
    return data.contact ?? null;
  } catch {
    /* A deleted or inaccessible contact should cost the campaign label, not
       the whole report. */
    return null;
  }
}

/**
 * Which calendars to count appointments on.
 *
 * Defaults to every calendar on the location, which is correct but costs one
 * request per calendar per report. This location has eleven and only one takes
 * funnel bookings, so GHL_CALENDAR_IDS (comma separated) narrows it and keeps
 * the report well inside the rate limit.
 */
async function fetchCalendarIds(token: string, locationId: string): Promise<string[]> {
  const configured = (process.env['GHL_CALENDAR_IDS'] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;

  const data = await ghlFetch<{ calendars?: Array<{ id?: string }> }>(
    `/calendars/?locationId=${encodeURIComponent(locationId)}`,
    token,
  );
  return (data.calendars ?? []).map(c => c.id).filter((id): id is string => Boolean(id));
}

async function fetchEvents(
  token: string,
  locationId: string,
  calendarIds: string[],
  fromMs: number,
  toMs: number,
): Promise<GhlEvent[]> {
  const all: GhlEvent[] = [];

  /* Serial rather than parallel: the rate limit is per location, so firing
     every calendar at once is the fastest way to get throttled. */
  for (const calendarId of calendarIds) {
    const qs = new URLSearchParams({
      locationId,
      calendarId,
      startTime: String(fromMs),
      endTime: String(toMs),
    });
    const data = await ghlFetch<{ events?: GhlEvent[] }>(
      `/calendars/events?${qs.toString()}`,
      token,
    );
    all.push(...(data.events ?? []));
    await sleep(REQUEST_SPACING_MS);
  }

  return all;
}

/* ─────────────────────────── shaping ─────────────────────────── */

/**
 * Whichever attribution object actually carries data.
 *
 * GHL returns `{}` rather than null when it has nothing, and an empty object is
 * truthy — so `attributionSource ?? lastAttributionSource` stops at the empty
 * first-touch object and never looks at the last-touch one that holds the real
 * data. On this location that silently mislabelled a large share of contacts as
 * unattributed.
 */
function usefulAttribution(contact: GhlContact): Attribution | null {
  const first = contact.attributionSource;
  if (first && Object.keys(first).length > 0) return first;
  const last = contact.lastAttributionSource;
  if (last && Object.keys(last).length > 0) return last;
  return null;
}

/** The campaign a contact came from, or a readable bucket when there is none. */
export function campaignOf(contact: GhlContact): string {
  const a = usefulAttribution(contact);
  if (!a) return 'Unattributed';

  const named = a.campaign;
  if (named) return String(named).trim();

  /* A campaign id is not pretty, but it is still a real campaign and belongs in
     its own row rather than merged with everything else. */
  if (a.campaignId) return `Campaign ${a.campaignId}`;

  /* No campaign at all, but we can still say where it came from, which beats
     lumping paid social in with direct traffic. */
  const source = a.utmSource || a.adSource || a.sessionSource || a.referrer;
  if (source) return `${String(source).trim()} (no campaign name)`;

  return 'Unattributed';
}

/**
 * The channel a contact arrived through — a coarser cut than campaign, and
 * worth its own panel because attribution often carries a source even when no
 * campaign name survived the journey.
 */
export function sourceOf(contact: GhlContact): string {
  const a = usefulAttribution(contact);
  if (!a) return 'Unattributed';
  const s = a.sessionSource || a.utmSource || a.adSource || a.medium || a.referrer;
  return s ? String(s).trim() : 'Unattributed';
}

/** Appointments that were cancelled never represent a booking that stood up. */
function isLiveAppointment(e: GhlEvent): boolean {
  return !/^(cancelled|canceled|invalid)$/.test(statusOf(e));
}

/** Normalised appointment status, lowercased, defaulting to a named bucket
    rather than an empty string so it can be counted and labelled. */
function statusOf(e: GhlEvent): string {
  return String(e.appointmentStatus ?? e.status ?? 'unknown').toLowerCase().trim() || 'unknown';
}

/**
 * How far the zone is from UTC at a given instant, in ms.
 * Formats the instant in the zone, reads it back as if it were UTC, and takes
 * the difference — which handles daylight saving without a date library.
 */
function zoneOffsetMs(atMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atMs));

  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;

  const asUtc = Date.UTC(
    Number(p['year']),
    Number(p['month']) - 1,
    Number(p['day']),
    Number(p['hour']) % 24,
    Number(p['minute']),
    Number(p['second']),
  );

  /* formatToParts only resolves to whole seconds, so measuring against an
     instant ending .999 yields 3,599,001 instead of 3,600,000 — and that 999ms
     shortfall was enough to push the end-of-day boundary past midnight and add
     a phantom day to the chart. Real offsets are whole minutes, so round. */
  return Math.round((asUtc - atMs) / 60000) * 60000;
}

/**
 * The instant a calendar day starts or ends *in the viewer's zone*.
 *
 * Without this, "to 2026-09-14" was read as 23:59 UTC, which is already the
 * 15th in London, so the chart grew a trailing day outside the range the
 * header claimed.
 */
function zonedDayBoundary(day: string, timeZone: string, endOfDay: boolean): number {
  const guess = Date.parse(`${day}${endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`);
  if (!Number.isFinite(guess)) return NaN;
  return guess - zoneOffsetMs(guess, timeZone);
}

function dayKey(ms: number, timeZone: string): string {
  /* en-CA formats as YYYY-MM-DD, which sorts lexicographically. */
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function eachDay(fromMs: number, toMs: number, timeZone: string): string[] {
  const days: string[] = [];
  for (let t = fromMs; t <= toMs; t += 86400000) days.push(dayKey(t, timeZone));
  const last = dayKey(toMs, timeZone);
  if (days[days.length - 1] !== last) days.push(last);
  return [...new Set(days)];
}

/* ─────────────────────────── cache ─────────────────────────── */

const cache = new Map<string, { at: number; payload: unknown }>();
const CACHE_TTL_MS = 60 * 1000;

/* ─────────────────────────── CORS ───────────────────────────
   The dashboard is served from GitHub Pages and this function runs on Vercel,
   so every request from the page is cross-origin. That is allowed only for
   origins named here: an open `*` would let any site on the internet put up its
   own page, prompt a MadeEA person for the dashboard key, and read the funnel
   back. Set ALLOWED_ORIGINS to override (comma separated, scheme + host, no
   trailing slash).

   There is no Access-Control-Allow-Credentials, deliberately. Auth is the
   explicit x-dashboard-key header, never a cookie, so the browser has no
   ambient credential to leak here.

   Sending that header makes this a non-simple request, so the browser fires a
   preflight OPTIONS first — hence the OPTIONS export. Without it the preflight
   404s and every fetch fails before the GET is ever reached. */
const DEFAULT_ALLOWED_ORIGINS = ['https://thelbertd.github.io'];

function allowedOrigins(): string[] {
  const raw = process.env['ALLOWED_ORIGINS'];
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/* Vary: Origin on every response, including the ones that get no
   Allow-Origin. Without it a CDN can cache the permissive answer given to an
   allowed origin and hand it to a different one. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin) return { Vary: 'Origin' };
  if (!allowedOrigins().includes(origin)) return { Vary: 'Origin' };
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'x-dashboard-key, content-type',
    'Access-Control-Max-Age': '86400',
  };
}

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request): Promise<Response> {
  const response = await handleGet(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(request))) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

/* ─────────────────────────── handler ─────────────────────────── */

async function handleGet(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const token = process.env['GHL_PRIVATE_TOKEN'];
  const locationId = process.env['GHL_LOCATION_ID'];
  const dashboardKey = process.env['DASHBOARD_KEY'];

  if (!token || !locationId) {
    return jsonResponse(503, {
      error: 'not_configured',
      message: 'GHL_PRIVATE_TOKEN and GHL_LOCATION_ID are not set on this deployment.',
    });
  }

  /* Refuse to run without a key rather than defaulting to open. An unguarded
     route here would publish the whole funnel's performance to anyone who
     guessed the path. */
  if (!dashboardKey) {
    return jsonResponse(503, {
      error: 'not_configured',
      message:
        'DASHBOARD_KEY is not set. Set one before using this route, or the numbers are public.',
    });
  }

  if (isRateLimited(clientIp(request))) {
    return jsonResponse(429, { error: 'rate_limited', message: 'Too many requests.' });
  }

  const supplied = request.headers.get('x-dashboard-key') ?? url.searchParams.get('key') ?? '';
  if (!timingSafeEqual(supplied, dashboardKey)) {
    return jsonResponse(401, { error: 'unauthorized', message: 'Wrong or missing dashboard key.' });
  }

  /* A quick "is my integration wired up correctly" probe. */
  if (url.searchParams.get('check') === '1') {
    return jsonResponse(200, await runScopeCheck(token, locationId));
  }

  const timeZone = url.searchParams.get('tz') || 'UTC';
  const range = parseRange(url, timeZone);
  if ('error' in range) return jsonResponse(400, range);

  const cacheKey = `${range.fromMs}:${range.toMs}:${timeZone}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return jsonResponse(200, hit.payload);
  }

  try {
    /* Fetch the selected window AND the equally long window before it in one
       pass, then split locally. A number on its own says nothing — "7 leads" is
       only meaningful next to what the previous 30 days did — and contacts come
       back newest-first, so covering both costs no extra requests. */
    const windowMs = range.toMs - range.fromMs;
    const prevFromMs = range.fromMs - windowMs - 1;
    const prevToMs = range.fromMs - 1;

    const allContacts = await fetchContacts(token, locationId, prevFromMs, range.toMs);
    const calendarIds = await fetchCalendarIds(token, locationId);

    /* Cancellations are kept here and filtered afterwards: the outcome panel
       needs them, and they are the most interesting thing on it. */
    const everyEvent = await fetchEvents(token, locationId, calendarIds, prevFromMs, range.toMs);
    const allEvents = everyEvent.filter(isLiveAppointment);

    const contactMs = (c: GhlContact) => Date.parse(c.dateAdded ?? '');
    const eventMs = (e: GhlEvent) =>
      typeof e.startTime === 'number' ? e.startTime : Date.parse(String(e.startTime));
    const inWindow = (t: number, a: number, b: number) => Number.isFinite(t) && t >= a && t <= b;

    const contacts = allContacts.filter(c => inWindow(contactMs(c), range.fromMs, range.toMs));
    const events = allEvents.filter(e => inWindow(eventMs(e), range.fromMs, range.toMs));

    /* Every booking made in the window, cancelled or not. */
    const bookedInWindow = everyEvent.filter(e => inWindow(eventMs(e), range.fromMs, range.toMs));
    const outcomeCounts = new Map<string, number>();
    for (const e of bookedInWindow) {
      const s = statusOf(e);
      outcomeCounts.set(s, (outcomeCounts.get(s) ?? 0) + 1);
    }
    const prevLeads = allContacts.filter(c => inWindow(contactMs(c), prevFromMs, prevToMs)).length;
    const prevAppointments = allEvents.filter(e => inWindow(eventMs(e), prevFromMs, prevToMs)).length;

    /* Appointments inherit the campaign of the contact who booked them, so a
       booking is credited to the ad that produced the lead. */
    const campaignByContact = new Map<string, string>();
    const lateSources = new Map<string, string>();
    for (const c of contacts) if (c.id) campaignByContact.set(c.id, campaignOf(c));

    /* Fill in the bookers who became contacts before this window. Capped,
       because this is one request each and the rate limit is per location. */
    const unknown = [
      ...new Set(
        events
          .map(e => e.contactId)
          .filter((id): id is string => Boolean(id) && !campaignByContact.has(id!)),
      ),
    ];
    const toLookUp = unknown.slice(0, MAX_CONTACT_LOOKUPS);
    for (const id of toLookUp) {
      const c = await fetchContactById(token, id);
      if (c) {
        campaignByContact.set(id, campaignOf(c));
        lateSources.set(id, sourceOf(c));
      }
      await sleep(REQUEST_SPACING_MS);
    }
    const unresolvedBookers = unknown.length - toLookUp.length;

    const days = eachDay(range.fromMs, range.toMs, timeZone);
    const byDay = new Map<string, DayRow>(
      days.map(d => [d, { date: d, leads: 0, appointments: 0 }]),
    );
    const byCampaign = new Map<string, CampaignRow>();
    const bySource = new Map<string, CampaignRow>();
    const sourceByContact = new Map<string, string>();
    for (const c of contacts) if (c.id) sourceByContact.set(c.id, sourceOf(c));
    for (const [id, s] of lateSources) if (!sourceByContact.has(id)) sourceByContact.set(id, s);

    const bump = (
      map: Map<string, CampaignRow>,
      name: string,
      key: 'leads' | 'appointments',
    ) => {
      const row = map.get(name) ?? { campaign: name, leads: 0, appointments: 0 };
      row[key] += 1;
      map.set(name, row);
    };

    for (const c of contacts) {
      const t = Date.parse(c.dateAdded ?? '');
      if (!Number.isFinite(t)) continue;
      const row = byDay.get(dayKey(t, timeZone));
      if (row) row.leads += 1;
      bump(byCampaign, campaignOf(c), 'leads');
      bump(bySource, sourceOf(c), 'leads');
    }

    for (const e of events) {
      const t = typeof e.startTime === 'number' ? e.startTime : Date.parse(String(e.startTime));
      if (!Number.isFinite(t)) continue;
      const row = byDay.get(dayKey(t, timeZone));
      if (row) row.appointments += 1;
      bump(
        byCampaign,
        (e.contactId && campaignByContact.get(e.contactId)) || 'Booker not resolved',
        'appointments',
      );
      bump(
        bySource,
        (e.contactId && sourceByContact.get(e.contactId)) || 'Booker not resolved',
        'appointments',
      );
    }

    const leads = contacts.length;
    const appointments = events.length;

    const payload = {
      range: { from: range.from, to: range.to, timeZone },
      totals: {
        leads,
        appointments,
        /* Null rather than 0 when there are no leads: a booking rate of "0%"
           and "no data yet" are different things and the tile says so. */
        bookingRate: leads > 0 ? appointments / leads : null,
      },
      previous: {
        from: dayKey(prevFromMs, timeZone),
        to: dayKey(prevToMs, timeZone),
        leads: prevLeads,
        appointments: prevAppointments,
        bookingRate: prevLeads > 0 ? prevAppointments / prevLeads : null,
      },
      /* Every booking made in the window, by status. Cancellations are in here
         on purpose — they are excluded from the appointment count but are the
         most useful thing on the outcomes panel. */
      outcomes: [...outcomeCounts.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
      byDay: days.map(d => byDay.get(d)!),
      bySource: [...bySource.values()].sort((a, b) => b.leads - a.leads),
      byCampaign: [...byCampaign.values()].sort((a, b) => b.leads - a.leads),
      meta: {
        calendarsScanned: calendarIds.length,
        contactPagesCapped: contacts.length >= MAX_CONTACT_PAGES * CONTACT_PAGE_SIZE,
        unresolvedBookers,
        generatedAt: new Date().toISOString(),
      },
    };

    cache.set(cacheKey, { at: Date.now(), payload });
    if (cache.size > 50) cache.clear();

    return jsonResponse(200, payload);
  } catch (err) {
    if (err instanceof GhlError) {
      return jsonResponse(err.status === 401 || err.status === 403 ? err.status : 502, {
        error: 'ghl_error',
        endpoint: err.endpoint,
        message: err.message,
      });
    }
    console.error('ghl-metrics failed:', err);
    return jsonResponse(500, { error: 'server_error', message: 'Could not build the report.' });
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

function parseRange(
  url: URL,
  timeZone: string,
): { from: string; to: string; fromMs: number; toMs: number } | { error: string; message: string } {
  const toRaw = url.searchParams.get('to');
  const fromRaw = url.searchParams.get('from');

  /* Boundaries are resolved in the viewer's zone so the window matches the day
     buckets. Reading them as UTC made "to 2026-09-14" end at 00:59 on the 15th
     in London, which grew a trailing day on the chart. */
  const toMs = toRaw ? zonedDayBoundary(toRaw, timeZone, true) : Date.now();
  const fromMs = fromRaw
    ? zonedDayBoundary(fromRaw, timeZone, false)
    : toMs - 29 * 86400000; /* default: last 30 days inclusive */

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { error: 'bad_range', message: 'from and to must be YYYY-MM-DD.' };
  }
  if (fromMs > toMs) {
    return { error: 'bad_range', message: 'from is after to.' };
  }
  if (toMs - fromMs > MAX_RANGE_DAYS * 86400000) {
    return {
      error: 'bad_range',
      message: `Range is longer than ${MAX_RANGE_DAYS} days, which would exhaust the GHL rate limit.`,
    };
  }

  return {
    from: dayKey(fromMs, timeZone),
    to: dayKey(toMs, timeZone),
    fromMs,
    toMs,
  };
}

/** Constant-time compare, so the key cannot be guessed a character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Calls each endpoint once and reports what worked, so a missing scope is
    named instead of surfacing as a blank dashboard. */
async function runScopeCheck(token: string, locationId: string) {
  const results: Array<{ scope: string; endpoint: string; ok: boolean; detail: string }> = [];

  const probe = async (scope: string, endpoint: string, run: () => Promise<unknown>) => {
    try {
      await run();
      results.push({ scope, endpoint, ok: true, detail: 'OK' });
    } catch (err) {
      results.push({
        scope,
        endpoint,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await probe('contacts.readonly', 'POST /contacts/search', () =>
    ghlFetch('/contacts/search', token, {
      method: 'POST',
      body: JSON.stringify({ locationId, page: 1, pageLimit: 1 }),
    }),
  );

  let calendarIds: string[] = [];
  await probe('calendars.readonly', 'GET /calendars/', async () => {
    calendarIds = await fetchCalendarIds(token, locationId);
  });

  if (calendarIds.length > 0) {
    const now = Date.now();
    await probe('calendars/events.readonly', 'GET /calendars/events', () =>
      fetchEvents(token, locationId, calendarIds.slice(0, 1), now - 86400000, now),
    );
  } else {
    results.push({
      scope: 'calendars/events.readonly',
      endpoint: 'GET /calendars/events',
      ok: false,
      detail: 'Skipped: no calendars were returned, so there was nothing to query.',
    });
  }

  return {
    locationId,
    calendarsFound: calendarIds.length,
    allPassed: results.every(r => r.ok),
    results,
  };
}
