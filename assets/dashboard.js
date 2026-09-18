/* ==========================================================================
   MadeEA Analytics — dashboard behaviour.
   No framework, no build step, no dependencies, same as the funnel pages.
   ========================================================================== */
(function () {
  "use strict";

  var CFG = window.MADEEA_DASHBOARD_CONFIG || {};
  var STORE = "madeeaDashKey";
  var NS = "http://www.w3.org/2000/svg";

  /* Where the numbers come from. An empty apiBase means "same origin", which
     is correct on Vercel, where the function is deployed next to the page. */
  var BASE = String(CFG.apiBase || "").replace(/\/$/, "");
  var API = BASE + "/api/ghl-metrics";

  /* GitHub Pages cannot run the function, so an unset apiBase there is a
     misconfiguration, not a transient failure. Saying so beats letting the
     user watch a fetch 404 against a path that will never exist. */
  var NEEDS_API_BASE = !BASE && /\.github\.io$/i.test(location.hostname);

  var $ = function (id) { return document.getElementById(id); };
  var el = function (n, a) {
    var e = document.createElementNS(NS, n);
    for (var k in a) if (a[k] !== null && a[k] !== undefined) e.setAttribute(k, a[k]);
    return e;
  };
  var txt = function (n, a, s) { var e = el(n, a); e.textContent = s; return e; };
  var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  var iso = function (d) { return d.toISOString().slice(0, 10); };
  var pct = function (n) { return Math.round(n * 1000) / 10 + "%"; };
  var DASH = "—";

  /* ─────────── brand chrome ─────────── */
  (function chrome() {
    var bar = document.querySelector("[data-topbar]");
    if (!bar) return;
    bar.innerHTML =
      '<div class="inner">' +
        '<span class="brand">' +
          '<svg viewBox="0 0 1210 1456" aria-hidden="true">' +
            '<polygon points="0,0 306,0 306,926 0,1106"></polygon>' +
            '<polygon points="452,0 758,0 758,1171 452,1351"></polygon>' +
            '<polygon points="904,0 1210,0 1210,1276 904,1456"></polygon>' +
          '</svg>' +
          '<span class="wordmark">Made&thinsp;/&thinsp;EA</span>' +
        '</span>' +
        '<span class="trust">' + esc(CFG.trustLine || "Private report") + "</span>" +
      "</div>";
  })();

  /* ─────────── auth ─────────── */
  function key() { try { return sessionStorage.getItem(STORE) || ""; } catch (e) { return ""; } }
  function setKey(v) { try { sessionStorage.setItem(STORE, v); } catch (e) {} }
  function clearKey() { try { sessionStorage.removeItem(STORE); } catch (e) {} }

  function gate(message) {
    $("app").hidden = true; $("gate").hidden = false;
    var err = $("gateErr");
    if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
    $("keyInput").focus();
  }

  $("gateForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("keyInput").value.trim();
    if (!v) return;
    setKey(v); $("gate").hidden = true; $("app").hidden = false; load();
  });
  $("signout").addEventListener("click", function () { clearKey(); gate(""); });

  /* ─────────── range ─────────── */
  function preset(days) {
    var to = new Date(), from = new Date(to.getTime() - (days - 1) * 86400000);
    $("from").value = iso(from); $("to").value = iso(to);
  }
  preset(30);
  Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (o) {
        o.setAttribute("aria-pressed", String(o === b));
      });
      preset(Number(b.dataset.days)); load();
    });
  });
  $("apply").addEventListener("click", function () {
    Array.prototype.forEach.call(document.querySelectorAll(".seg button"), function (o) {
      o.setAttribute("aria-pressed", "false");
    });
    load();
  });

  /* ─────────── load ─────────── */
  var current = null;
  var PANELS = ["kpis", "pDay", "pFunnel", "pOutcome", "pSource", "pCamp"];
  function panels(show) { PANELS.forEach(function (id) { $(id).hidden = !show; }); }
  function msg(html, bad) {
    $("msg").innerHTML = html ? '<div class="note' + (bad ? " err" : "") + '">' + html + "</div>" : "";
  }

  function load() {
    if (!key()) { gate(""); return; }

    if (NEEDS_API_BASE) {
      panels(false);
      msg("<b>This copy has no API to talk to</b>" +
          "GitHub Pages serves static files only, so the metrics function is not running beside this page. " +
          "Deploy <code>api/</code> to Vercel, then set <code>apiBase</code> in <code>assets/config.js</code> " +
          "to that deployment's URL.", true);
      return;
    }

    msg("Loading…", false);
    var tz = "UTC";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) {}

    fetch(API + "?from=" + encodeURIComponent($("from").value) +
              "&to=" + encodeURIComponent($("to").value) +
              "&tz=" + encodeURIComponent(tz),
          { headers: { "x-dashboard-key": key() } })
      .then(function (r) { return r.json().then(function (b) { return { s: r.status, b: b }; }); })
      .then(function (res) {
        if (res.s === 401) { clearKey(); gate("That key was not accepted."); return; }
        if (res.s !== 200) {
          panels(false);
          msg("<b>" + esc(res.b.error || "Error") + "</b>" + esc(res.b.message || "") +
              (res.b.endpoint ? "<br><small>" + esc(res.b.endpoint) + "</small>" : ""), true);
          return;
        }
        current = res.b; msg("", false); panels(true); render(current);
      })
      .catch(function () {
        panels(false);
        /* A cross-origin deployment fails here for one of two reasons, and the
           browser will not say which: the deployment is down, or its
           ALLOWED_ORIGINS does not list this page. Name both. */
        msg("<b>Could not reach the server</b>" +
            (BASE
              ? "Check <code>" + esc(BASE) + "</code> is live, and that its <code>ALLOWED_ORIGINS</code> " +
                "includes <code>" + esc(location.origin) + "</code>."
              : "Check the deployment is live, then try again."), true);
      });
  }

  /* ─────────── render ─────────── */
  function render(d) {
    var leads = d.totals.leads, appts = d.totals.appointments;
    var outcomes = d.outcomes || [];
    var booked = outcomes.reduce(function (a, o) { return a + o.count; }, 0);
    var cancelled = outcomes.reduce(function (a, o) {
      return a + (isBad(o.status) ? o.count : 0);
    }, 0);

    $("sub").textContent = d.range.from + " to " + d.range.to + " · " + d.range.timeZone;
    $("kLeads").textContent = leads.toLocaleString();
    $("kAppts").textContent = appts.toLocaleString();
    $("kRate").textContent = d.totals.bookingRate === null ? DASH : pct(d.totals.bookingRate);
    $("kHeld").textContent = booked > 0 ? pct((booked - cancelled) / booked) : DASH;
    $("nHeld").innerHTML = booked > 0
      ? "<em>" + (booked - cancelled) + " of " + booked + " bookings stood up</em>"
      : "<em>no bookings yet</em>";
    $("kCanc").textContent = cancelled.toLocaleString();
    $("nCanc").innerHTML = "<em>" + (booked > 0 ? pct(cancelled / booked) + " of bookings" : "none") + "</em>";

    var prev = d.previous || null;
    delta($("dLeads"), leads, prev && prev.leads, prev);
    delta($("dAppts"), appts, prev && prev.appointments, prev);
    delta($("dRate"),
      d.totals.bookingRate === null ? null : d.totals.bookingRate * 100,
      !prev || prev.bookingRate === null ? null : prev.bookingRate * 100, prev, "pp");

    if (d.meta && d.meta.contactPagesCapped) {
      msg("<b>Partial count</b>This range hit the page cap, so leads are undercounted. Narrow the range.", true);
    }

    lineChart($("sDay"), d.byDay);
    dayTable($("tDay"), d.byDay);
    funnel(d, booked, cancelled);
    outcomePanel(outcomes, booked);
    barChart($("sSource"), d.bySource || [], 6);
    barChart($("sCamp"), d.byCampaign || [], 6);
    campTable($("tCamp"), d.byCampaign || []);
  }

  function isBad(status) { return /cancel|invalid|noshow|no-show/.test(String(status)); }

  /* Direction never rests on colour alone: an arrow and words come with it. */
  function delta(node, now, before, prev, unit) {
    if (!prev || now === null || before === null || before === undefined) {
      node.textContent = ""; node.className = "d"; return;
    }
    var diff = now - before;
    var rel = before !== 0 ? (diff / before) * 100 : null;
    var dir = diff > 0.05 ? "up" : diff < -0.05 ? "down" : "flat";
    var arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "→";
    var shown = unit === "pp"
      ? (diff >= 0 ? "+" : "") + (Math.round(diff * 10) / 10) + " pts"
      : (diff >= 0 ? "+" : "") + diff + (rel === null ? "" : " (" + (rel >= 0 ? "+" : "") + Math.round(rel) + "%)");
    node.className = "d " + dir;
    node.innerHTML = arrow + " " + esc(dir === "flat" ? "no change" : shown) + " <em>vs previous</em>";
  }

  /* Stages drawn against the first, so the drop is the point. */
  function funnel(d, booked, cancelled) {
    var leads = d.totals.leads;
    /* "Bookings made" counts every booking including the ones later cancelled,
       so it is deliberately NOT the same number as the Appointments tile,
       which excludes them. Naming both "appointments" made the two panels
       look like they disagreed. */
    var stages = [
      { l: "Leads", v: leads, c: css("--leads"), note: "" },
      { l: "Bookings made", v: booked, c: css("--appts"), note: leads ? pct(booked / leads) : "" },
      { l: "Held, not cancelled", v: booked - cancelled, c: css("--ok"), note: booked ? pct((booked - cancelled) / booked) : "" }
    ];
    var max = Math.max(1, leads);
    $("funnel").innerHTML = stages.map(function (s) {
      var w = Math.max(s.v > 0 ? 2 : 0, (s.v / max) * 100);
      return '<div class="fnrow"><span class="l">' + esc(s.l) + "</span>" +
        '<span class="fntrack"><span class="fnbar" style="width:' + w + "%;background:" + s.c + '"></span></span>' +
        '<span class="v">' + s.v.toLocaleString() + (s.note ? "<em>" + s.note + "</em>" : "") + "</span></div>";
    }).join("");
  }

  /* A stacked bar rather than a donut. With two statuses a ring is the wrong
     form, and a ring makes the first and last segments adjacent — which is
     where the rejected green/red pair failed its separation check. */
  function outcomePanel(outcomes, booked) {
    var box = $("outcome");
    if (!booked) { box.innerHTML = '<p class="empty">No bookings in this window.</p>'; return; }
    var colour = function (s) { return isBad(s) ? css("--bad") : css("--ok"); };
    var label = function (s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); };

    box.innerHTML =
      '<div class="oc">' + outcomes.map(function (o) {
        return '<span title="' + esc(label(o.status)) + ": " + o.count + '" style="width:' +
          ((o.count / booked) * 100) + "%;background:" + colour(o.status) + '"></span>';
      }).join("") + "</div>" +
      '<div class="ocleg">' + outcomes.map(function (o) {
        return '<div><i style="background:' + colour(o.status) + '"></i>' + esc(label(o.status)) +
          " <b>" + o.count + "</b> <u>" + pct(o.count / booked) + "</u></div>";
      }).join("") + "</div>";
  }

  /* Time series: 2px lines, one shared axis, direct label on the last point,
     crosshair tooltip, markers only on shorter ranges. */
  function lineChart(svg, rows) {
    svg.textContent = "";
    if (!rows || !rows.length) return;
    var W = 1100, H = 260, L = 40, R = 48, T = 14, B = 28;
    var iw = W - L - R, ih = H - T - B;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    var max = 0;
    rows.forEach(function (r) { max = Math.max(max, r.leads, r.appointments); });
    max = Math.max(4, Math.ceil(max * 1.18));
    var x = function (i) { return rows.length === 1 ? L + iw / 2 : L + (i / (rows.length - 1)) * iw; };
    var y = function (v) { return T + ih - (v / max) * ih; };

    for (var i = 0; i <= 4; i++) {
      var t = Math.round((max / 4) * i);
      svg.appendChild(el("line", { x1: L, x2: L + iw, y1: y(t), y2: y(t), class: "gridline" }));
      svg.appendChild(txt("text", { x: L - 8, y: y(t) + 4, "text-anchor": "end", class: "ax n" }, t));
    }
    var step = Math.max(1, Math.ceil(rows.length / 9));
    rows.forEach(function (r, idx) {
      if (idx % step !== 0 && idx !== rows.length - 1) return;
      svg.appendChild(txt("text", { x: x(idx), y: H - 9, "text-anchor": "middle", class: "ax" }, r.date.slice(5)));
    });

    [["leads", css("--leads")], ["appointments", css("--appts")]].forEach(function (s) {
      var f = s[0], c = s[1];
      svg.appendChild(el("polyline", {
        points: rows.map(function (r, i) { return x(i) + "," + y(r[f]); }).join(" "),
        fill: "none", stroke: c, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round"
      }));
      /* Markers are knocked out against the panel, not the page: these sit on
         white cards, so a cream halo would show as a dirty ring. */
      if (rows.length <= 45) rows.forEach(function (r, i) {
        svg.appendChild(el("circle", { cx: x(i), cy: y(r[f]), r: 4, fill: c, stroke: css("--white"), "stroke-width": 2 }));
      });
      var last = rows[rows.length - 1];
      svg.appendChild(txt("text", { x: x(rows.length - 1) + 9, y: y(last[f]) + 4, fill: c, class: "dl" }, last[f]));
    });

    var vline = el("line", { y1: T, y2: T + ih, class: "gridline", "stroke-width": 2, opacity: 0 });
    svg.appendChild(vline);
    svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: T + ih, fill: "transparent" }));

    function near(ev) {
      var b = svg.getBoundingClientRect(), px = ((ev.clientX - b.left) / b.width) * W, best = 0, bd = Infinity;
      rows.forEach(function (r, i) { var dd = Math.abs(x(i) - px); if (dd < bd) { bd = dd; best = i; } });
      return best;
    }
    function show(ev) {
      var i = near(ev), r = rows[i], tip = $("tt");
      vline.setAttribute("x1", x(i)); vline.setAttribute("x2", x(i)); vline.setAttribute("opacity", 1);
      tip.innerHTML = '<p class="d">' + esc(r.date) + "</p>" +
        '<p class="r"><span><i style="background:var(--leads)"></i> Leads</span><b>' + r.leads + "</b></p>" +
        '<p class="r"><span><i style="background:var(--appts)"></i> Appointments</span><b>' + r.appointments + "</b></p>";
      tip.style.opacity = 1;
      tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 10, Math.max(10, ev.clientX + 14)) + "px";
      tip.style.top = Math.max(10, ev.clientY - tip.offsetHeight - 12) + "px";
    }
    function hide() { $("tt").style.opacity = 0; vline.setAttribute("opacity", 0); }
    svg.addEventListener("mousemove", show);
    svg.addEventListener("mouseleave", hide);
    svg.addEventListener("touchmove", function (e) { if (e.touches[0]) show(e.touches[0]); }, { passive: true });
    svg.addEventListener("touchend", hide);
  }

  /* Ranked paired bars, sorted by leads. Square ends to match the brand's 2px
     geometry, a 2px gap between the pair, direct labels, per-row hover. */
  function barChart(svg, rows, limit) {
    svg.textContent = "";
    if (!rows.length) {
      svg.setAttribute("viewBox", "0 0 560 46");
      svg.appendChild(txt("text", { x: 0, y: 26, class: "ax" }, "Nothing in this range."));
      return;
    }
    var top = rows.slice(0, limit);
    var W = 560, LBL = 158, R = 46, G = 42, BAR = 14, GAP = 2;
    var H = top.length * G + 12;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    var max = 1; top.forEach(function (r) { max = Math.max(max, r.leads, r.appointments); });
    var iw = W - LBL - R;
    var w = function (v) { return Math.max(v > 0 ? 3 : 0, (v / max) * iw); };

    top.forEach(function (r, i) {
      var gy = i * G + 6;
      var name = r.campaign.length > 22 ? r.campaign.slice(0, 21) + "…" : r.campaign;
      var lab = txt("text", { x: LBL - 10, y: gy + BAR + GAP / 2 + 4, "text-anchor": "end", class: "ax" }, name);
      lab.appendChild(txt("title", {}, r.campaign));
      svg.appendChild(lab);

      [["leads", css("--leads"), gy], ["appointments", css("--appts"), gy + BAR + GAP]].forEach(function (s) {
        svg.appendChild(el("rect", { x: LBL, y: s[2], width: w(r[s[0]]), height: BAR, fill: s[1] }));
        svg.appendChild(txt("text", { x: LBL + w(r[s[0]]) + 7, y: s[2] + BAR - 2, fill: s[1], class: "dl" }, r[s[0]]));
      });

      var hit = el("rect", { x: 0, y: gy - 3, width: W, height: G - 2, fill: "transparent" });
      hit.addEventListener("mousemove", function (ev) {
        var tip = $("tt");
        tip.innerHTML = '<p class="d">' + esc(r.campaign) + "</p>" +
          '<p class="r"><span><i style="background:var(--leads)"></i> Leads</span><b>' + r.leads + "</b></p>" +
          '<p class="r"><span><i style="background:var(--appts)"></i> Appointments</span><b>' + r.appointments + "</b></p>" +
          '<p class="r"><span>Booking rate</span><b>' + (r.leads ? pct(r.appointments / r.leads) : DASH) + "</b></p>";
        tip.style.opacity = 1;
        tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 10, ev.clientX + 14) + "px";
        tip.style.top = Math.max(10, ev.clientY - tip.offsetHeight - 12) + "px";
      });
      hit.addEventListener("mouseleave", function () { $("tt").style.opacity = 0; });
      svg.appendChild(hit);
    });

    if (rows.length > top.length) {
      svg.appendChild(txt("text", { x: LBL, y: H - 1, class: "ax" }, "+ " + (rows.length - top.length) + " more"));
    }
  }

  function rateCell(r) { return r.leads > 0 ? pct(r.appointments / r.leads) : DASH; }

  function dayTable(t, rows) {
    t.innerHTML = "<thead><tr><th>Date</th><th class='n'>Leads</th><th class='n'>Appointments</th><th class='n'>Rate</th></tr></thead><tbody>" +
      rows.map(function (r) {
        return "<tr><td>" + esc(r.date) + "</td><td class='n'>" + r.leads + "</td><td class='n'>" +
          r.appointments + "</td><td class='n'>" + rateCell(r) + "</td></tr>";
      }).join("") + "</tbody>";
  }
  function campTable(t, rows) {
    t.innerHTML = "<thead><tr><th>Campaign</th><th class='n'>Leads</th><th class='n'>Appointments</th><th class='n'>Rate</th></tr></thead><tbody>" +
      rows.map(function (r) {
        return "<tr><td>" + esc(r.campaign) + "</td><td class='n'>" + r.leads + "</td><td class='n'>" +
          r.appointments + "</td><td class='n'>" + rateCell(r) + "</td></tr>";
      }).join("") + "</tbody>";
  }

  /* CSV rather than a PDF "report": it opens in the tools this team already
     uses, and needs no library. */
  $("csv").addEventListener("click", function () {
    if (!current) return;
    var rows = [["date", "leads", "appointments"]];
    current.byDay.forEach(function (r) { rows.push([r.date, r.leads, r.appointments]); });
    rows.push([], ["campaign", "leads", "appointments"]);
    (current.byCampaign || []).forEach(function (r) {
      rows.push(['"' + String(r.campaign).replace(/"/g, '""') + '"', r.leads, r.appointments]);
    });
    var blob = new Blob([rows.map(function (r) { return r.join(","); }).join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "madeea-funnel-" + current.range.from + "-to-" + current.range.to + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  $("year").textContent = new Date().getFullYear();

  window.addEventListener("resize", function () { if (current) render(current); });
  if (key()) { $("app").hidden = false; load(); } else { gate(""); }
})();
