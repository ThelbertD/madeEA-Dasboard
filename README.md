# MadeEA funnel dashboard

A private report of the paid funnel: leads landing in GoHighLevel, appointments
booked off them, and the split by campaign.

- `public/index.html` — the dashboard
- `api/ghl-metrics.ts` — the serverless route that talks to GHL

## Why the token is not in the page

A GHL Private Integration token can read the whole sub-account: contacts,
conversations, calendars, opportunities. Anything in browser JavaScript is
readable by anyone who opens DevTools, so a dashboard calling GHL directly
would hand the CRM to any visitor. The token stays in an environment variable
on the server and the browser only ever receives counts. GHL also refuses
cross-origin browser calls, so the proxy is required either way.

## Deploying

**This cannot run on GitHub Pages.** Pages serves static files only, and the
dashboard gets every number from `/api/ghl-metrics`, a serverless function.
On Pages you get the login box and then a failed fetch on every request.
Hosting the API elsewhere and pointing the page at it would mean opening the
route to cross-origin callers, which is a worse trade than it sounds.

Deploy to a host that runs both the static file and the function. Vercel is
what `vercel.json` is set up for:

1. vercel.com/new, import this repository.
2. Framework preset **Other**. Leave the build command empty; output
   directory `public`. `vercel.json` already says so.
3. Add the environment variables below before the first deploy, or the route
   returns 503 until you do.
4. Deploy, then open `/api/ghl-metrics?check=1&key=YOUR_KEY` to confirm the
   GHL scopes before trusting any figure on the page.

If GitHub Pages is enabled on this repo, turn it off: it can only ever serve
a broken copy.

## Setup

1. **Create the Private Integration** — GHL → Settings → Private Integrations.
   Tick these scopes and nothing more:
   - `contacts.readonly`
   - `calendars.readonly`
   - `calendars/events.readonly`
2. **Set environment variables** in Vercel → Settings → Environment Variables
   (see `.env.example`):

   | Variable | What it is |
   |---|---|
   | `GHL_PRIVATE_TOKEN` | the token, starts `pit-` |
   | `GHL_LOCATION_ID` | the sub-account id, visible in the GHL dashboard URL |
   | `DASHBOARD_KEY` | passphrase the dashboard sends; without it the route refuses to serve |
   | `GHL_CALENDAR_IDS` | optional, comma separated; limits which calendars count |

3. **Deploy**, then confirm the integration before trusting any numbers:

   ```
   /api/ghl-metrics?check=1&key=YOUR_DASHBOARD_KEY
   ```

   That calls each endpoint once and names any missing scope, instead of
   failing later as a blank dashboard.

## Running locally

```bash
cp .env.example .env     # fill it in
npm install
npm run typecheck
```

There is no build step: the dashboard is a single static HTML file. To exercise
the API locally you need a runtime that serves `public/` and runs `api/` in one
process — `vercel dev` does this.

## Panels

- **KPI row** — leads, appointments, booking rate, held rate, cancellations,
  each against the equally long period before.
- **Lead acquisition activity** — leads and appointments per day on one shared
  axis, with a crosshair readout.
- **Lead funnel** — leads, bookings made, bookings held.
- **Appointment outcomes** — every booking in the window by status.
- **Source performance** and **Campaign performance** — paired bars, sorted.

## What the numbers mean

- **Leads** — contacts created inside the range.
- **Appointments** — calendar events starting in the range. Cancellations are
  excluded, so this counts bookings that stood up.
- **Booking rate** — appointments divided by leads. Shown as `—` rather than 0%
  when there are no leads, because "nobody booked" and "no data yet" are
  different things.
- **Change vs previous** — every tile compares against the equally long period
  immediately before. The selected window and the one before it are fetched in
  one pass, so the comparison costs no extra requests.
- **Bookings made vs Appointments** — the funnel counts every booking
  including ones later cancelled; the Appointments tile excludes them. They
  are deliberately different numbers.
- **Held rate** — bookings that were not cancelled, over all bookings made.
- **By campaign** — a booking is credited to the campaign that produced the
  lead, read from the contact's attribution. Bookers who became contacts before
  the window are looked up individually (capped at 60) so they land on their
  real campaign rather than inflating an "unattributed" row.

## Known limits

- **Ranges are capped at 180 days** and contact paging is capped, because GHL
  allows roughly 100 requests per 10 seconds per location. If a range hits the
  cap the dashboard says so rather than quietly undercounting.
- **Attribution is only as good as what GHL recorded.** If the booking link
  carries no UTM parameters, GHL records the booking widget itself as the
  source and the campaign breakdown collapses into "Direct traffic". That is a
  funnel tracking problem, not a reporting one — the dashboard is reporting
  honestly when it looks empty.
- **`DASHBOARD_KEY` is a shared passphrase**, not per-user auth. It keeps the
  numbers off the open web; it is not an access control system.
