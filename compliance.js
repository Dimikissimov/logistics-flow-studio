/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * compliance.js - workplace-guideline "Compliance Check" (pure module)
 * ---------------------------------------------------------------------
 * A DETERMINISTIC, PURE function that reads an in-memory layout (racks /
 * aisles / dock doors / geometry) and returns a STRUCTURED findings
 * report. Every check is *informed by* a published German workplace
 * guideline and reuses the SAME domain constants and aisle definition as
 * the rest of the app (domain.js) - it does not fork the standards logic.
 *
 * HARD HONESTY: this is a design aid, NOT a certification, a legal-
 * compliance guarantee, or a Gefaehrdungsbeurteilung (risk assessment).
 * The figures shown are published guidance values, not legally binding
 * limits, and a passing check does NOT mean the layout is compliant.
 * The disclaimer below is embedded in every report so a logged/exported
 * report can never be mistaken for a compliance certificate.
 *
 * Checks (each -> pass / warn / fail, with measured + informed-by value,
 * offending element ids and a plain-language DE/EN explanation):
 *   1. aisle-width   - working aisle width per the truck class (DIN 15185)
 *   2. traffic-route - clear run of the main route in front of each dock
 *                      (ASR A1.8 traffic routes)
 *   3. escape-route  - egress reachability + route width + travel
 *                      distance from storage to an exit (ASR A2.3)
 *   4. blocked-route - a dock door sealed shut so its route is blocked
 *                      (ASR A1.8 / A2.3 - a hard obstruction)
 *
 * The escape/traffic/blocked checks are geometric HEURISTICS over a
 * 1 m occupancy grid: docks are treated as the building's exits and
 * every other placed element as a wall. They approximate egress logic;
 * they are not a fire-safety or building-code assessment.
 *
 * No frameworks, no build step, no network. Classic script attaching to
 * the global `WT` namespace so it works from file:// too.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;

  const REPORT_VERSION = "wt-compliance-1";

  // Stable, bilingual "this is NOT a certification" disclaimer. Matches
  // the tone of the existing standards-panel disclaimer (index.html) and
  // the domain.js "design aid only, not a compliance check" wording.
  const DISCLAIMER = {
    en:
      "Informed by German workplace guidelines (ASR A1.8 traffic routes, ASR A2.3 escape routes, DIN 15185 working aisles) - this is a design aid, NOT a certification, a legal-compliance guarantee, or a Gefaehrdungsbeurteilung (risk assessment). The values shown are published guidance figures, not legally binding limits, and a passing check does NOT mean the layout is compliant. Verify any real design against the current official texts and a qualified professional.",
    de:
      "Orientiert an deutschen Arbeitsstaetten-Leitlinien (ASR A1.8 Verkehrswege, ASR A2.3 Fluchtwege, DIN 15185 Arbeitsgaenge) - dies ist eine Planungshilfe, KEINE Zertifizierung, keine Zusicherung der Rechtskonformitaet und keine Gefaehrdungsbeurteilung. Die angezeigten Werte sind veroeffentlichte Richtwerte, keine rechtsverbindlichen Grenzwerte; ein bestandener Check bedeutet NICHT, dass die Anordnung konform ist. Jede reale Planung mit den aktuellen Originaltexten und einer Fachkraft pruefen.",
  };

  // Aisle-width warn band: at/above the truck-class minimum but with less
  // than this much clearance margin -> warn (meets the value, tight).
  const AISLE_WARN_MARGIN = 0.25;

  const SEVERITY_RANK = { fail: 0, warn: 1, pass: 2 };

  // ------------------------------------------------------------------
  // Small pure helpers.
  // ------------------------------------------------------------------
  function isStorage(el) { return (D.ELEMENTS[el.type] || {}).category === "storage"; }
  function isDock(el) { return el.type === "dock-in" || el.type === "dock-out"; }
  function round1(n) { return Math.round(n * 10) / 10; }
  function labelOf(el) { return (D.ELEMENTS[el.type] || {}).label || el.type; }

  // Occupancy grid: occ[y*W + x] = the covering element, or null. Every
  // placed element (storage + flow + docks) occupies its footprint.
  function buildOcc(layout) {
    const W = layout.gridW, H = layout.gridH;
    const occ = new Array(W * H).fill(null);
    for (const e of layout.elements) {
      for (let y = e.y; y < e.y + e.d; y++) {
        for (let x = e.x; x < e.x + e.w; x++) {
          if (x >= 0 && x < W && y >= 0 && y < H) occ[y * W + x] = e;
        }
      }
    }
    return occ;
  }

  // A cell is walkable if it is inside the grid and either empty or a
  // dock (a dock is a door - the exit - so the flood may pass into it).
  function walkable(occ, W, H, x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const el = occ[y * W + x];
    return el === null || isDock(el);
  }

  // Multi-source BFS from every dock cell through walkable cells. Returns
  // per-cell distance in CELLS from the nearest dock (-1 = unreachable).
  // Deterministic: sources and neighbour order are fixed.
  function floodFromDocks(layout, occ) {
    const W = layout.gridW, H = layout.gridH;
    const dist = new Int32Array(W * H).fill(-1);
    const q = [];
    for (const e of layout.elements) {
      if (!isDock(e)) continue;
      for (let y = e.y; y < e.y + e.d; y++) {
        for (let x = e.x; x < e.x + e.w; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const idx = y * W + x;
          if (dist[idx] === -1) { dist[idx] = 0; q.push(idx); }
        }
      }
    }
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    while (head < q.length) {
      const idx = q[head++];
      const cx = idx % W, cy = (idx - cx) / W;
      for (const [dx, dy] of NB) {
        const nx = cx + dx, ny = cy + dy;
        if (!walkable(occ, W, H, nx, ny)) continue;
        const nidx = ny * W + nx;
        if (dist[nidx] === -1) { dist[nidx] = dist[idx] + 1; q.push(nidx); }
      }
    }
    return dist;
  }

  // Direction from a dock into the hall interior: toward whichever edge
  // the dock is NOT on (perimeter docks), else toward the grid centre.
  function hallDirection(dock, W, H) {
    if (dock.y <= 0) return [0, 1];
    if (dock.y + dock.d >= H) return [0, -1];
    if (dock.x <= 0) return [1, 0];
    if (dock.x + dock.w >= W) return [-1, 0];
    const cx = W / 2, cy = H / 2;
    const mx = dock.x + dock.w / 2, my = dock.y + dock.d / 2;
    return Math.abs(cx - mx) >= Math.abs(cy - my)
      ? [cx - mx >= 0 ? 1 : -1, 0]
      : [0, cy - my >= 0 ? 1 : -1];
  }

  // Is this element a hard obstruction to a goods/traffic route? Empty
  // floor, dock doors and flow CONNECTORS (staging, conveyor, pack,
  // push/pull) are passable - a dock feeding directly into staging or a
  // conveyor is the DESIGNED material flow, not a blockage. Only storage
  // racking (and the grid wall) actually blocks a route through a door.
  function blocksRoute(el) {
    return !!el && !isDock(el) && !D.isConnector(el);
  }

  // For each lane across a dock's opening, count the clear run of route
  // cells into the hall (up to `maxDepth`), passing through empty floor
  // and flow connectors and stopping at the first storage obstruction.
  // Returns the best (deepest) clear lane and the ids that obstruct it.
  function dockClearRun(dock, occ, W, H, maxDepth) {
    const [dx, dy] = hallDirection(dock, W, H);
    // Cells sitting just outside the dock along the hall direction.
    const lanes = [];
    if (dx !== 0) {
      const sx = dx > 0 ? dock.x + dock.w : dock.x - 1;
      for (let y = dock.y; y < dock.y + dock.d; y++) lanes.push([sx, y]);
    } else {
      const sy = dy > 0 ? dock.y + dock.d : dock.y - 1;
      for (let x = dock.x; x < dock.x + dock.w; x++) lanes.push([x, sy]);
    }
    let best = 0;
    const blockers = [];
    for (const [lx, ly] of lanes) {
      let depth = 0, x = lx, y = ly;
      for (let step = 0; step < maxDepth; step++) {
        if (x < 0 || y < 0 || x >= W || y >= H) break; // grid wall
        const el = occ[y * W + x];
        if (blocksRoute(el)) { if (blockers.indexOf(el.id) === -1) blockers.push(el.id); break; }
        depth++;
        x += dx; y += dy;
      }
      if (depth > best) best = depth;
    }
    return { bestDepthCells: best, blockers };
  }

  // ------------------------------------------------------------------
  // Finding + report builders.
  // ------------------------------------------------------------------
  function finding(o) {
    return {
      ruleId: o.ruleId,
      rule: o.rule,                 // {en, de}
      guideline: o.guideline,       // e.g. "DIN 15185"
      status: o.status,             // "pass" | "warn" | "fail"
      informedBy: o.informedBy || null, // {value, unit, label:{en,de}}
      measured: o.measured || null,     // {value, unit, label:{en,de}} | null
      elements: o.elements || [],       // offending element ids
      explain: o.explain,           // {en, de}
    };
  }

  // ==================================================================
  // RULE 1 - working aisle width (informed by DIN 15185).
  // Reuses the SHARED facing-pair + aisle definition from domain.js.
  // ==================================================================
  function checkAisleWidth(layout, minAisle) {
    const rule = { en: "Working aisle width", de: "Arbeitsgangbreite" };
    const guideline = "DIN 15185";
    const informedBy = {
      value: round1(minAisle), unit: "m",
      label: {
        en: "min " + round1(minAisle) + " m clear working aisle for the selected truck class",
        de: "min. " + round1(minAisle) + " m freier Arbeitsgang fuer die gewaehlte Fahrzeugklasse",
      },
    };
    const pairs = D.facingAislePairs(layout.elements);
    const fails = pairs.filter((p) => p.gapM < minAisle - 1e-6);
    const warns = pairs.filter((p) => p.gapM >= minAisle - 1e-6 && p.gapM < minAisle + AISLE_WARN_MARGIN - 1e-6);
    const out = [];

    // Aggregate per status (one finding each) so a big layout does not
    // bury the user in near-identical rows; the elements array still
    // carries every offending rack id for click-to-highlight.
    function idsOf(list) {
      const ids = [];
      for (const p of list) {
        if (ids.indexOf(p.a.id) === -1) ids.push(p.a.id);
        if (ids.indexOf(p.b.id) === -1) ids.push(p.b.id);
      }
      return ids;
    }
    if (fails.length) {
      const narrowest = round1(Math.min.apply(null, fails.map((p) => p.gapM)));
      out.push(finding({
        ruleId: "aisle-width", rule, guideline, status: "fail", informedBy,
        measured: {
          value: narrowest, unit: "m",
          label: { en: narrowest + " m narrowest facing-row gap", de: narrowest + " m engster Gang" },
        },
        elements: idsOf(fails),
        explain: {
          en: fails.length + " facing rack-row aisle(s) are below the " + round1(minAisle) +
            " m working aisle the selected truck class needs (narrowest " + narrowest +
            " m). Widen the flagged gaps or pick a narrower-aisle truck (e.g. VNA).",
          de: fails.length + " gegenueberliegende Regalgaenge liegen unter dem benoetigten Arbeitsgang von " +
            round1(minAisle) + " m (engster " + narrowest +
            " m). Gaenge verbreitern oder schmalere Fahrzeugklasse (z. B. VNA) waehlen.",
        },
      }));
    }
    if (warns.length) {
      const tightest = round1(Math.min.apply(null, warns.map((p) => p.gapM)));
      out.push(finding({
        ruleId: "aisle-width", rule, guideline, status: "warn", informedBy,
        measured: {
          value: tightest, unit: "m",
          label: { en: tightest + " m tightest facing-row gap", de: tightest + " m engster Gang" },
        },
        elements: idsOf(warns),
        explain: {
          en: warns.length + " facing rack-row aisle(s) meet the " + round1(minAisle) +
            " m guidance value but with little clearance margin (tightest " + tightest +
            " m). Fine for the guidance figure, but leaves little room for error.",
          de: warns.length + " gegenueberliegende Regalgaenge erreichen den Richtwert von " + round1(minAisle) +
            " m, aber mit geringer Reserve (engster " + tightest + " m).",
        },
      }));
    }
    if (!out.length) {
      out.push(finding({
        ruleId: "aisle-width", rule, guideline, status: "pass", informedBy,
        explain: {
          en: pairs.length
            ? "All " + pairs.length + " facing rack-row aisle(s) clear the " + round1(minAisle) + " m working-aisle guidance."
            : "No facing rack-row aisles to assess.",
          de: pairs.length
            ? "Alle " + pairs.length + " gegenueberliegenden Regalgaenge erfuellen den Richtwert von " + round1(minAisle) + " m."
            : "Keine gegenueberliegenden Regalgaenge zu pruefen.",
        },
      }));
    }
    return out;
  }

  // ==================================================================
  // RULE 2 - main traffic route in front of each dock (ASR A1.8).
  // Measures the clear run into the hall directly ahead of the dock.
  // A fully sealed door (0 clear) is left to RULE 4 (blocked-route);
  // here we report narrow-but-open routes as a warn, clear as pass.
  // ==================================================================
  function checkTrafficRoute(layout, occ, W, H) {
    const rule = { en: "Main traffic route", de: "Hauptverkehrsweg" };
    const guideline = "ASR A1.8";
    const minM = D.COMPLIANCE.mainRouteMinMetres;
    const cell = layout.cell || 1;
    const informedBy = {
      value: minM, unit: "m",
      label: {
        en: "min " + minM + " m clear run for the main route in front of a dock",
        de: "min. " + minM + " m freier Verkehrsweg vor einem Tor",
      },
    };
    const maxDepth = Math.ceil(minM / cell);
    const docks = layout.elements.filter(isDock);
    const out = [];
    for (const dock of docks) {
      const run = dockClearRun(dock, occ, W, H, maxDepth);
      const depthM = round1(run.bestDepthCells * cell);
      if (run.bestDepthCells === 0) continue; // sealed -> blocked-route rule
      if (depthM < minM - 1e-6) {
        out.push(finding({
          ruleId: "traffic-route", rule, guideline, status: "warn", informedBy,
          measured: {
            value: depthM, unit: "m",
            label: { en: depthM + " m clear in front of the dock", de: depthM + " m frei vor dem Tor" },
          },
          elements: [dock.id].concat(run.blockers),
          explain: {
            en: "The main route in front of " + labelOf(dock) + " at (" + dock.x + ", " + dock.y + ") is only " +
              depthM + " m clear before an obstruction - below the " + minM + " m informed-by clearance for a truck route. Keep the area ahead of the door clear.",
            de: "Der Hauptverkehrsweg vor " + labelOf(dock) + " bei (" + dock.x + ", " + dock.y + ") ist nur " +
              depthM + " m frei bis zu einem Hindernis - unter dem Richtwert von " + minM + " m fuer einen Fahrzeugweg. Bereich vor dem Tor freihalten.",
          },
        }));
      }
    }
    if (!out.length) {
      out.push(finding({
        ruleId: "traffic-route", rule, guideline, status: "pass", informedBy,
        explain: {
          en: docks.length
            ? "Every dock has at least " + minM + " m of clear main route in front of it."
            : "No dock door placed - the main traffic route cannot be assessed.",
          de: docks.length
            ? "Vor jedem Tor liegen mindestens " + minM + " m freier Hauptverkehrsweg."
            : "Kein Tor platziert - der Hauptverkehrsweg kann nicht geprueft werden.",
        },
      }));
    }
    return out;
  }

  // ==================================================================
  // RULE 3 - escape route reachability + width + travel distance
  // (ASR A2.3). Storage elements must reach a dock (exit) through free
  // floor; the walkable network must not pinch below the width value;
  // and travel to an exit should stay within the distance value.
  // ==================================================================
  function checkEscapeRoute(layout, occ, W, H, dist) {
    const rule = { en: "Escape route", de: "Fluchtweg" };
    const guideline = "ASR A2.3";
    const cell = layout.cell || 1;
    const widthMin = D.COMPLIANCE.escapeWidthMinMetres;
    const travelMax = D.COMPLIANCE.escapeMaxTravelMetres;
    const informedBy = {
      value: widthMin, unit: "m",
      label: {
        en: "min " + widthMin + " m clear escape-route width; <= " + travelMax + " m travel to an exit",
        de: "min. " + widthMin + " m freie Fluchtwegbreite; <= " + travelMax + " m Weg bis zum Ausgang",
      },
    };
    const storage = layout.elements.filter(isStorage);
    const docks = layout.elements.filter(isDock);
    const out = [];

    if (!docks.length) {
      out.push(finding({
        ruleId: "escape-route", rule, guideline, status: "warn", informedBy,
        explain: {
          en: "No exit (dock door) is placed, so egress cannot be assessed - add at least one dock door.",
          de: "Kein Ausgang (Tor) platziert - Fluchtwege koennen nicht geprueft werden. Mindestens ein Tor hinzufuegen.",
        },
      }));
      return out;
    }

    // 3a. Reachability + travel distance per storage element.
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let farthest = null;
    for (const e of storage) {
      let best = -1;
      for (let y = e.y; y < e.y + e.d; y++) {
        for (let x = e.x; x < e.x + e.w; x++) {
          for (const [dx, dy] of NB) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const dcell = dist[ny * W + nx];
            if (dcell >= 0 && (best === -1 || dcell < best)) best = dcell;
          }
        }
      }
      if (best === -1) {
        out.push(finding({
          ruleId: "escape-route", rule, guideline, status: "fail", informedBy,
          elements: [e.id],
          explain: {
            en: labelOf(e) + " at (" + e.x + ", " + e.y + ") has NO free-floor path to any exit - it is boxed in. A blocked escape route must be cleared.",
            de: labelOf(e) + " bei (" + e.x + ", " + e.y + ") hat KEINEN freien Weg zu einem Ausgang - eingeschlossen. Ein blockierter Fluchtweg muss freigemacht werden.",
          },
        }));
      } else {
        const travelM = best * cell;
        if (!farthest || travelM > farthest.travelM) farthest = { e: e, travelM: travelM };
      }
    }
    if (farthest && farthest.travelM > travelMax + 1e-6) {
      const tm = round1(farthest.travelM);
      out.push(finding({
        ruleId: "escape-route", rule, guideline, status: "warn", informedBy,
        measured: {
          value: tm, unit: "m",
          label: { en: tm + " m travel to the nearest exit", de: tm + " m Weg bis zum naechsten Ausgang" },
        },
        elements: [farthest.e.id],
        explain: {
          en: labelOf(farthest.e) + " at (" + farthest.e.x + ", " + farthest.e.y + ") is ~" + tm +
            " m of floor travel from the nearest exit - beyond the " + travelMax + " m informed-by distance. Add a nearer dock door or an intermediate route.",
          de: labelOf(farthest.e) + " bei (" + farthest.e.x + ", " + farthest.e.y + ") ist ~" + tm +
            " m vom naechsten Ausgang entfernt - ueber dem Richtwert von " + travelMax + " m. Naeheres Tor oder Zwischenweg vorsehen.",
        },
      }));
    }

    // 3b. Route WIDTH: count 1 m-wide pinches on the reachable network.
    let pinches = 0;
    const pinchEls = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (dist[idx] < 0) continue;              // unreachable
        const here = occ[idx];
        if (here && isDock(here)) continue;       // the door itself
        if (here) continue;                        // occupied (shouldn't happen for reached)
        const L = walkable(occ, W, H, x - 1, y), R = walkable(occ, W, H, x + 1, y);
        const U = walkable(occ, W, H, x, y - 1), Dn = walkable(occ, W, H, x, y + 1);
        const vert = !L && !R && U && Dn;          // 1-wide vertical corridor
        const horiz = !U && !Dn && L && R;         // 1-wide horizontal corridor
        if (cell < widthMin - 1e-6 && (vert || horiz)) {
          pinches++;
          const sides = vert ? [[x - 1, y], [x + 1, y]] : [[x, y - 1], [x, y + 1]];
          for (const [sx, sy] of sides) {
            if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
            const se = occ[sy * W + sx];
            if (se && !isDock(se) && pinchEls.indexOf(se.id) === -1) pinchEls.push(se.id);
          }
        }
      }
    }
    if (pinches > 0) {
      const wM = round1(cell);
      out.push(finding({
        ruleId: "escape-route", rule, guideline, status: "warn", informedBy,
        measured: {
          value: wM, unit: "m",
          label: { en: "~" + wM + " m at the narrowest passage", de: "~" + wM + " m an der engsten Stelle" },
        },
        elements: pinchEls.slice(0, 8),
        explain: {
          en: "The walkable escape network squeezes to about " + wM + " m wide at " + pinches +
            " location(s) - below the " + widthMin + " m informed-by escape-route width. Widen the tightest passages.",
          de: "Das begehbare Fluchtwegnetz verengt sich an " + pinches + " Stelle(n) auf etwa " + wM +
            " m - unter dem Richtwert von " + widthMin + " m fuer die Fluchtwegbreite. Engste Stellen verbreitern.",
        },
      }));
    }

    if (!out.length) {
      out.push(finding({
        ruleId: "escape-route", rule, guideline, status: "pass", informedBy,
        explain: {
          en: storage.length
            ? "Every storage element reaches an exit through free floor, within the " + travelMax + " m distance and above the " + widthMin + " m width guidance."
            : "No storage elements to assess for egress.",
          de: storage.length
            ? "Jedes Lagerelement erreicht einen Ausgang ueber freien Boden, innerhalb " + travelMax + " m und ueber der Breite von " + widthMin + " m."
            : "Keine Lagerelemente fuer die Fluchtwegpruefung.",
        },
      }));
    }
    return out;
  }

  // ==================================================================
  // RULE 4 - blocked-route detection: a dock door whose opening is
  // sealed shut (zero clear cells in front) so no route can pass
  // through it. A hard obstruction, reported as fail.
  // ==================================================================
  function checkBlockedRoute(layout, occ, W, H) {
    const rule = { en: "Blocked route", de: "Blockierter Weg" };
    const guideline = "ASR A1.8";
    const docks = layout.elements.filter(isDock);
    const out = [];
    for (const dock of docks) {
      const run = dockClearRun(dock, occ, W, H, 1);
      if (run.bestDepthCells === 0) {
        out.push(finding({
          ruleId: "blocked-route", rule, guideline, status: "fail",
          elements: [dock.id].concat(run.blockers),
          explain: {
            en: "The route through " + labelOf(dock) + " at (" + dock.x + ", " + dock.y +
              ") is blocked - its opening is sealed by an adjacent element, so goods and people cannot pass. Clear the cells in front of the door.",
            de: "Der Weg durch " + labelOf(dock) + " bei (" + dock.x + ", " + dock.y +
              ") ist blockiert - die Toroeffnung ist durch ein angrenzendes Element versperrt. Zellen vor dem Tor freimachen.",
          },
        }));
      }
    }
    if (!out.length) {
      out.push(finding({
        ruleId: "blocked-route", rule, guideline, status: "pass",
        explain: {
          en: docks.length
            ? "No dock door is sealed - every placed route opening is clear."
            : "No dock door placed - no through-route to block.",
          de: docks.length
            ? "Kein Tor ist versperrt - jede Wegeoeffnung ist frei."
            : "Kein Tor platziert - kein Durchgang, der blockiert sein koennte.",
        },
      }));
    }
    return out;
  }

  // ==================================================================
  // Public entry point: check(layout, config) -> structured report.
  // Pure & deterministic: no Date, no random, no side effects.
  // ==================================================================
  function check(layout, config) {
    const lay = {
      elements: (layout && layout.elements) || [],
      gridW: (layout && layout.gridW) || 40,
      gridH: (layout && layout.gridH) || 24,
      cell: (layout && layout.cell) || D.METRES_PER_CELL,
    };
    const cfg = config || {};
    const minAisle = typeof cfg.minAisleMetres === "number" ? cfg.minAisleMetres : D.AISLE.defaultMinMetres;
    const W = lay.gridW, H = lay.gridH;

    const occ = buildOcc(lay);
    const dist = floodFromDocks(lay, occ);

    let findings = [];
    findings = findings.concat(checkAisleWidth(lay, minAisle));
    findings = findings.concat(checkTrafficRoute(lay, occ, W, H));
    findings = findings.concat(checkEscapeRoute(lay, occ, W, H, dist));
    findings = findings.concat(checkBlockedRoute(lay, occ, W, H));

    // Worst-first, stable within a severity (insertion order preserved).
    findings.forEach((f, i) => (f._i = i));
    findings.sort((a, b) => (SEVERITY_RANK[a.status] - SEVERITY_RANK[b.status]) || (a._i - b._i));
    findings.forEach((f) => delete f._i);

    const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
    for (const f of findings) summary[f.status]++;
    summary.worst = summary.fail ? "fail" : summary.warn ? "warn" : "pass";

    return {
      version: REPORT_VERSION,
      disclaimer: DISCLAIMER,
      guidelines: [
        { code: "DIN 15185", topic: { en: "Working aisles", de: "Arbeitsgaenge" },
          value: round1(minAisle) + " m (selected truck class)", note: D.AISLE.note },
        { code: "ASR A1.8", topic: { en: "Traffic routes", de: "Verkehrswege" },
          value: D.COMPLIANCE.mainRouteMinMetres + " m main route", note: D.COMPLIANCE.mainRouteNote },
        { code: "ASR A2.3", topic: { en: "Escape routes", de: "Fluchtwege" },
          value: D.COMPLIANCE.escapeWidthMinMetres + " m width; <= " + D.COMPLIANCE.escapeMaxTravelMetres + " m travel",
          note: D.COMPLIANCE.escapeNote },
      ],
      summary,
      findings,
    };
  }

  WT.compliance = { check, DISCLAIMER, REPORT_VERSION };
})();
