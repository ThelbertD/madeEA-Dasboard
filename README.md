# MadeEA funnel dashboard

A private report of the paid funnel: leads landing in GoHighLevel, appointments
booked off them, and the split by campaign. Brand and structure match the
MadeEA sales funnel — same tokens from madeeas.com, same "one config file to go
live" shape, no build step, no framework, no dependencies.

```
index.html            the dashboard
assets/config.js      ← the only file you edit to go live
assets/dashboard.css  brand tokens + layout
assets/dashboard.js   auth gate, range, charts, CSV
api/ghl-metrics.ts    the serverless route that talks to GHL
.nojekyll             stops GitHub Pages rendering this README as the site
```

## Why the token is not in the page

A GHL Private Integration token can read the whole sub-account: contacts,
conversations, calendars, opportunities. Anything in browser JavaScript is
readable by anyone who opens DevTools, so a dashboard calling GHL directly
would hand the CRM to any visitor. The token stays in an environment variable
on the server and the browser only ever receives counts. GHL also refuses
cross-origin browser calls, so the proxy is required either way.

`assets/config.js` is served to the browser in clear text and holds a URL and
nothing more. The dashboard key is typed by whoever opens the report and kept
in `sessionStorage` for that tab only.

## Hosting

The page is static and the numbers are not. Those two halves can live on one
host or two.

**One host (simplest).** Deploy to Vercel. `vercel.json` serves the repo root
and runs `api/` as a function, so the page calls its own origin. Leave
`apiBase` in `assets/config.js` empty. Nothing else to set.

**Two hosts (GitHub Pages + Vercel).** Pages serves static files only, so it
can host the page but never the function. That split works, but only once both
sides are told about each other:

1. Deploy this repo to Vercel as above, with the environment variables below.
2. Set `apiBase` in `assets/config.js` to the Vercel URL, e.g.
   `https://madeea-dashboard.vercel.app`. No trailing slash. Commit and push.
3. Set `ALLOWED_ORIGINS` on the Vercel deployment to the Pages origin,
   `https://thelbertd.github.io`. It already defaults to that, so this is only
   needed if the page moves to another domain.

Until steps 1 and 2 are done, the Pages copy loads, shows the key prompt, and
then says it has no API to talk to — deliberately, rather than failing with an
opaque network error.

### Why `ALLOWED_ORIGINS` is a list and not `*`

The route is guarded by a shared passphrase that a person types in. With `*`,
any site on the internet could put up a convincing copy of this dashboard,
prompt a MadeEA person for that key, and read the funnel back through their
browser. The allow-list means only pages actually served from a MadeEA origin
can make the call.

### Why `.nojekyll` matters

GitHub Pages runs Jekyll over the repo root by default, which ignores
`index.html` in favour of rendering `README.md` as the site. That is exactly
what the Pages URL used to serve: this file, styled as a web page, instead of
the dashboard. `.nojekyll` turns that off.

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
   | `ALLOWED_ORIGINS` | optional, comma separated; browser origins allowed to call the route. Defaults to `https://thelbertd.github.io` |

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

There is no build step. To look at the page alone:

```bash
python -m http.server 8080
```

To exercise the API too you need a runtime that serves the root and runs `api/`
in one process — `vercel dev` does this.

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

## Colour

The data colours are checked, not chosen by eye, and the working is in the
header comment of `assets/dashboard.css`. Moving from the old dark console to
the cream brand surface invalidated the previous palette, so every value was
re-measured for contrast against `#FFFFFF` / `#FBF7F2` / `#FFF1EA` and for
separation under protanopia, deuteranopia and tritanopia.

Two results worth knowing before editing them:

- A plain brand green for "held" was tried and rejected — against the
  cancelled red it collapsed to dE 12.4 under deuteranopia, the ordinary
  red/green failure. The teal `#1A7F72` scores 24.0.
- The brand orange `#FD5811` never carries white text. That pairing is 3.19:1,
  which the funnel's 17px bold CTA gets away with and 13px dashboard buttons do
  not, so buttons use `#CE4410` at 4.71:1 — within 1.2 degrees of hue of the
  brand orange.

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
- **The two-host setup puts the key in a cross-origin request.** It is sent as
  a header over HTTPS to an allow-listed origin, never as a URL parameter, so
  it stays out of logs and referrers. Hosting both halves on Vercel avoids the
  question entirely.
