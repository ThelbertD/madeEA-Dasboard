/* ==========================================================================
   MadeEA Analytics — the only file you edit to go live.

   Same idea as the funnel's assets/config.js: the page itself never needs
   touching, so the thing that changes between environments is one short file
   instead of a diff inside 600 lines of dashboard.

   WHY apiBase EXISTS AT ALL
   GitHub Pages serves static files and nothing else. Every number on this page
   comes from /api/ghl-metrics, a serverless function, so on Pages there is no
   API next to the page and it has to be pointed at one that is running
   elsewhere. Leave apiBase empty when the page and the function are deployed
   together (Vercel) and the page will call its own origin.

   NOTHING SECRET GOES IN THIS FILE.
   It is served to the browser in clear text, so it holds a URL and nothing
   more. The dashboard key is typed by the person opening the report and kept
   in sessionStorage for that tab only; the GHL token never leaves the server.
   If you ever find yourself pasting a token here, that is the bug.
   ========================================================================== */

window.MADEEA_DASHBOARD_CONFIG = {
  /* Origin of the deployment that runs api/ghl-metrics.
     - Vercel (page + function together): leave as "".
     - GitHub Pages: the Vercel URL, e.g. "https://madeea-dashboard.vercel.app"
     No trailing slash. */
  apiBase: '',

  /* Shown in the top-right of the brand bar. Cosmetic. */
  trustLine: 'Private report',
};
