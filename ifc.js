/* =====================================================================
 * Logistics Flow Studio - WarehouseTwin
 * ifc.js - W4: the IFC export bridge (dependency-free IFC4 writer).
 * ---------------------------------------------------------------------
 * Serializes the current layout (the exact serialize() schema from
 * app.js) into an IFC 4 file in the ISO 10303-21 "STEP physical file"
 * encoding - the exchange language of BIM / planning offices. Written
 * from scratch in this module: no libraries, no network, no WASM.
 *
 * HONEST SCOPE (also stated in the UI + README): this is a SCOPED
 * coordination/viewing export, not full BIM authoring.
 *   - Spatial tree: IfcProject -> IfcSite -> IfcBuilding ->
 *     IfcBuildingStorey (aggregated with IfcRelAggregates), with
 *     IfcOwnerHistory, SI units in METRES and a world coordinate
 *     system at the grid origin.
 *   - Every placed element becomes ONE IfcBuildingElementProxy:
 *       Name           = "<type label> <element id>"
 *       ObjectPlacement= IfcLocalPlacement relative to the storey,
 *                        at the element's grid position in metres
 *                        (this app's grid has no element rotation, so
 *                        placements are pure translations)
 *       Body           = IfcExtrudedAreaSolid: the element's REAL
 *                        rectangular footprint extruded to the
 *                        per-type heightM from domain.js - heights
 *                        are labelled ASSUMPTIONS there and in the
 *                        exported property set
 *     contained in the storey via IfcRelContainedInSpatialStructure.
 *   - Each proxy carries an IfcPropertySet 'WT_ElementType' with the
 *     element type, category, capacity, the assumed height (flagged
 *     as an assumption), and - for storage systems - a VelocityClass
 *     (A/B/C) DERIVED from the same ABC idea the simulator teaches:
 *     storage ranked by distance to the I/O point, nearest ~20% of
 *     capacity = A, next ~30% = B, rest = C. Derived, not measured.
 *
 * Axis convention: IFC plan views put +Y "up" while the canvas grid's
 * y grows downward, so the writer flips y (ifcY = floorDepth - y - d).
 * A top-down look at the IFC model matches the app's floor view.
 *
 * Determinism: same layout object -> byte-identical file (pinned by
 * verify_ifc.js). GlobalIds are deterministic hashes of stable seeds
 * (role + element id), compressed to the standard 22-character IFC
 * base64 form. The FILE_NAME timestamp defaults to a fixed value; the
 * app passes the real export time (metadata only, geometry unchanged).
 *
 * Classic script on the global WT namespace (works over file://); also
 * loads in Node under the same window shim the harnesses use, so
 * verify_ifc.js exercises the REAL writer, not a copy.
 * ===================================================================== */
(function () {
  "use strict";
  const WT = (window.WT = window.WT || {});
  const D = WT.domain;

  const VERSION = "1.0";

  /* ------------------------------------------------------------------
   * STEP primitives.
   * ------------------------------------------------------------------ */

  // Real numbers in STEP always carry a decimal point ("6." / "2.5").
  function fmt(n) {
    if (typeof n !== "number" || !isFinite(n)) throw new Error("non-finite number in IFC output");
    if (Number.isInteger(n)) return n.toString() + ".";
    let s = n.toFixed(6).replace(/0+$/, "");
    if (s.charAt(s.length - 1) === ".") s += "0";
    return s;
  }

  // String escaping per ISO 10303-21: ' doubles, \ doubles, characters
  // outside the printable ASCII range use the \X2\..\X0\ (or \X4\ for
  // beyond the BMP) encoding.
  function stepString(s) {
    let out = "";
    for (const ch of String(s)) {
      const code = ch.codePointAt(0);
      if (ch === "'") out += "''";
      else if (ch === "\\") out += "\\\\";
      else if (code >= 32 && code <= 126) out += ch;
      else if (code <= 0xffff) out += "\\X2\\" + code.toString(16).toUpperCase().padStart(4, "0") + "\\X0\\";
      else out += "\\X4\\" + code.toString(16).toUpperCase().padStart(8, "0") + "\\X0\\";
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * Deterministic IfcGloballyUniqueId.
   * 128 bits from four salted FNV-1a/avalanche hashes of a stable seed
   * string, compressed to the standard 22-character IFC base64 form
   * (4 zero pad bits + 128 data bits = 22 x 6-bit digits; the first
   * digit is therefore always 0-3, as the spec requires).
   * ------------------------------------------------------------------ */
  const GUID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

  function hash32(str, seed) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return h >>> 0;
  }

  function guidFor(seedStr) {
    let bits = "0000";
    for (let r = 0; r < 4; r++) {
      const h = hash32(seedStr, Math.imul(r + 1, 0x9e3779b9) >>> 0);
      bits += h.toString(2).padStart(32, "0");
    }
    let out = "";
    for (let i = 0; i < 22; i++) out += GUID_ALPHABET[parseInt(bits.slice(i * 6, i * 6 + 6), 2)];
    return out;
  }

  /* ------------------------------------------------------------------
   * I/O point - MIRRORS simulation.js ioPointOf() (kept in sync so
   * ifc.js depends only on domain.js): centroid of outbound docks,
   * else inbound docks, else the floor centre.
   * ------------------------------------------------------------------ */
  function ioPointOf(elements, gridW, gridH, cell) {
    const pick = (type) => elements.filter((e) => e.type === type);
    let ref = pick("dock-out");
    if (ref.length === 0) ref = pick("dock-in");
    if (ref.length === 0) return { x: (gridW * cell) / 2, y: (gridH * cell) / 2 };
    let sx = 0, sy = 0;
    for (const e of ref) {
      sx += (e.x + e.w / 2) * cell;
      sy += (e.y + e.d / 2) * cell;
    }
    return { x: sx / ref.length, y: sy / ref.length };
  }

  /* ------------------------------------------------------------------
   * DERIVED velocity classes for storage elements (assumption, stated
   * in the pset): rank storage by centre distance to the I/O point;
   * nearest ~20% of total capacity = A, next ~30% = B, rest = C -
   * the slot-side counterpart of the ABC 80/20 slotting the simulator
   * teaches (domain.js STRATEGIES.abc). Deterministic: ties break on
   * the element id.
   * ------------------------------------------------------------------ */
  function velocityClasses(elements, gridW, gridH, cell) {
    const io = ioPointOf(elements, gridW, gridH, cell);
    const storage = elements
      .filter((e) => (D.ELEMENTS[e.type] || {}).category === "storage")
      .map((e) => {
        const cx = (e.x + e.w / 2) * cell;
        const cy = (e.y + e.d / 2) * cell;
        return { id: e.id, dist: Math.hypot(cx - io.x, cy - io.y), cap: D.elementCapacity(e) };
      })
      .sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const total = storage.reduce((s, e) => s + e.cap, 0) || 1;
    const out = {};
    let cum = 0;
    for (const e of storage) {
      const share = cum / total;
      out[e.id] = share < 0.2 ? "A" : share < 0.5 ? "B" : "C";
      cum += e.cap;
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * generate(layout, opts) -> the complete IFC file as a string.
   *   layout: the app.js serialize() schema
   *           { elements:[{id,type,x,y,w,d}], gridW, gridH, cell, ... }
   *   opts:   { name, projectName, author, timestamp } - all optional;
   *           defaults keep the output deterministic.
   * ------------------------------------------------------------------ */
  function generate(layout, opts) {
    opts = opts || {};
    if (!layout || !Array.isArray(layout.elements)) {
      throw new Error("generate() needs a serialized layout object with an elements array");
    }
    const cell = typeof layout.cell === "number" && layout.cell > 0 ? layout.cell : D.METRES_PER_CELL;
    const gridW = typeof layout.gridW === "number" ? layout.gridW : 40;
    const gridH = typeof layout.gridH === "number" ? layout.gridH : 24;
    // Unknown element types are dropped, same as deserialize() does.
    const els = layout.elements.filter((e) => e && D.ELEMENTS[e.type]);

    const baseName = opts.name || "warehousetwin-layout";
    const projectName = opts.projectName || "WarehouseTwin layout";
    const author = opts.author || "WarehouseTwin user";
    // Metadata timestamp only (geometry never depends on it). Fixed
    // default keeps generate() deterministic; the app passes real time.
    const ts = opts.timestamp || "2026-01-01T00:00:00Z";
    const tsSeconds = Math.floor((Date.parse(ts) || 0) / 1000);

    // ---- entity table: rows[i] becomes "#(i+1)=<row>;" ----
    const rows = [];
    const ref = (body) => {
      rows.push(body);
      return "#" + rows.length;
    };

    // ---- deterministic, file-unique GlobalIds ----
    const seenGuids = new Set();
    function guid(seed) {
      let g = guidFor(seed);
      for (let i = 1; seenGuids.has(g); i++) g = guidFor(seed + "#" + i);
      seenGuids.add(g);
      return g;
    }

    // ---- units: SI, metres ----
    const uLen = ref("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
    const uArea = ref("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)");
    const uVol = ref("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)");
    const uAng = ref("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)");
    const units = ref("IFCUNITASSIGNMENT((" + [uLen, uArea, uVol, uAng].join(",") + "))");

    // ---- world coordinate system + 3D model context ----
    const ptOrigin = ref("IFCCARTESIANPOINT((0.,0.,0.))");
    const dirZ = ref("IFCDIRECTION((0.,0.,1.))");
    const dirX = ref("IFCDIRECTION((1.,0.,0.))");
    const wcs = ref("IFCAXIS2PLACEMENT3D(" + ptOrigin + "," + dirZ + "," + dirX + ")");
    const trueNorth = ref("IFCDIRECTION((0.,1.))");
    const ctx3d = ref("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5," + wcs + "," + trueNorth + ")");

    // ---- owner history (honest authorship: this app, this writer) ----
    const person = ref("IFCPERSON($,$,'" + stepString(author) + "',$,$,$,$,$)");
    const org = ref("IFCORGANIZATION($,'WarehouseTwin',$,$,$)");
    const pao = ref("IFCPERSONANDORGANIZATION(" + person + "," + org + ",$)");
    const app = ref("IFCAPPLICATION(" + org + ",'" + VERSION + "','WarehouseTwin','WarehouseTwin')");
    const oh = ref("IFCOWNERHISTORY(" + pao + "," + app + ",$,.ADDED.,$,$,$," + tsSeconds + ")");

    // ---- spatial structure: project -> site -> building -> storey ----
    const project = ref(
      "IFCPROJECT('" + guid("wt-project") + "'," + oh + ",'" + stepString(projectName) +
      "','Scoped coordination model exported from WarehouseTwin (proxy solids; heights are assumptions)',$,$,$,(" +
      ctx3d + ")," + units + ")"
    );

    function placementAt(parentRef, x, y, z) {
      const pt = ref("IFCCARTESIANPOINT((" + fmt(x) + "," + fmt(y) + "," + fmt(z) + "))");
      const ax = ref("IFCAXIS2PLACEMENT3D(" + pt + ",$,$)");
      return ref("IFCLOCALPLACEMENT(" + (parentRef || "$") + "," + ax + ")");
    }

    const sitePlace = placementAt(null, 0, 0, 0);
    const site = ref(
      "IFCSITE('" + guid("wt-site") + "'," + oh + ",'WarehouseTwin site',$,$," + sitePlace +
      ",$,$,.ELEMENT.,$,$,$,$,$)"
    );
    const buildingPlace = placementAt(sitePlace, 0, 0, 0);
    const building = ref(
      "IFCBUILDING('" + guid("wt-building") + "'," + oh + ",'Warehouse',$,$," + buildingPlace +
      ",$,$,.ELEMENT.,$,$,$)"
    );
    const storeyPlace = placementAt(buildingPlace, 0, 0, 0);
    const storey = ref(
      "IFCBUILDINGSTOREY('" + guid("wt-storey") + "'," + oh + ",'Warehouse floor',$,$," + storeyPlace +
      ",$,$,.ELEMENT.,0.)"
    );

    ref("IFCRELAGGREGATES('" + guid("wt-rel-project-site") + "'," + oh + ",'Project container',$," + project + ",(" + site + "))");
    ref("IFCRELAGGREGATES('" + guid("wt-rel-site-building") + "'," + oh + ",'Site container',$," + site + ",(" + building + "))");
    ref("IFCRELAGGREGATES('" + guid("wt-rel-building-storey") + "'," + oh + ",'Building container',$," + building + ",(" + storey + "))");

    // ---- one IfcBuildingElementProxy per placed element ----
    const vClasses = velocityClasses(els, gridW, gridH, cell);
    const floorDepthM = gridH * cell;
    const proxies = [];

    for (const el of els) {
      const def = D.ELEMENTS[el.type];
      const wM = el.w * cell;
      const dM = el.d * cell;
      const hM = typeof def.heightM === "number" ? def.heightM : 1.0;
      // Canvas y grows downward; IFC plan +Y is up. Flip so a top-down
      // view of the model matches the app's floor view.
      const xM = el.x * cell;
      const yM = floorDepthM - (el.y + el.d) * cell;

      // Placement: pure translation (the grid has no element rotation).
      const place = placementAt(storeyPlace, xM, yM, 0);

      // Body: real rectangular footprint, extruded to the assumed
      // per-type height. IfcRectangleProfileDef is centred on its
      // position, so the profile centre sits at (w/2, d/2) locally.
      const pt2 = ref("IFCCARTESIANPOINT((" + fmt(wM / 2) + "," + fmt(dM / 2) + "))");
      const pos2 = ref("IFCAXIS2PLACEMENT2D(" + pt2 + ",$)");
      const profile = ref(
        "IFCRECTANGLEPROFILEDEF(.AREA.,'" + stepString(def.label) + " footprint'," + pos2 + "," +
        fmt(wM) + "," + fmt(dM) + ")"
      );
      const solidPos = ref("IFCAXIS2PLACEMENT3D(" + ptOrigin + ",$,$)");
      const solid = ref("IFCEXTRUDEDAREASOLID(" + profile + "," + solidPos + "," + dirZ + "," + fmt(hM) + ")");
      const shape = ref("IFCSHAPEREPRESENTATION(" + ctx3d + ",'Body','SweptSolid',(" + solid + "))");
      const pds = ref("IFCPRODUCTDEFINITIONSHAPE($,$,(" + shape + "))");

      const proxyName = def.label + " " + el.id;
      const proxy = ref(
        "IFCBUILDINGELEMENTPROXY('" + guid("wt-proxy|" + el.id) + "'," + oh + ",'" + stepString(proxyName) +
        "','Proxy solid for coordination/viewing; the " + fmt(hM) + " m height is an assumption','" +
        stepString(def.label) + "'," + place + "," + pds + ",'" + stepString(el.id) + "',$)"
      );
      proxies.push(proxy);

      // WT_ElementType property set: type + honest metadata.
      const props = [];
      props.push(ref("IFCPROPERTYSINGLEVALUE('ElementType',$,IFCLABEL('" + stepString(def.label) + "'),$)"));
      props.push(ref("IFCPROPERTYSINGLEVALUE('WTTypeId',$,IFCIDENTIFIER('" + stepString(el.type) + "'),$)"));
      props.push(ref("IFCPROPERTYSINGLEVALUE('Category',$,IFCLABEL('" + stepString(def.category) + "'),$)"));
      props.push(ref(
        "IFCPROPERTYSINGLEVALUE('HeightM','Assumed overall height used for the proxy extrusion - a teaching assumption, not a vendor spec',IFCLENGTHMEASURE(" +
        fmt(hM) + "),$)"
      ));
      props.push(ref("IFCPROPERTYSINGLEVALUE('HeightIsAssumption',$,IFCBOOLEAN(.T.),$)"));
      if (def.category === "storage") {
        props.push(ref(
          "IFCPROPERTYSINGLEVALUE('VelocityClass','Derived A/B/C from distance-to-I/O capacity ranking (ABC slotting assumption, not measured)',IFCLABEL('" +
          (vClasses[el.id] || "C") + "'),$)"
        ));
        props.push(ref("IFCPROPERTYSINGLEVALUE('PalletPositions',$,IFCCOUNTMEASURE(" + fmt(D.elementCapacity(el)) + "),$)"));
      }
      const pset = ref(
        "IFCPROPERTYSET('" + guid("wt-pset|" + el.id) + "'," + oh + ",'WT_ElementType',$,(" + props.join(",") + "))"
      );
      ref(
        "IFCRELDEFINESBYPROPERTIES('" + guid("wt-relprops|" + el.id) + "'," + oh + ",$,$,(" + proxy + ")," + pset + ")"
      );
    }

    // ---- contain every proxy in the storey (empty aggregates are not
    //      legal STEP, so the relationship is omitted for empty floors)
    if (proxies.length > 0) {
      ref(
        "IFCRELCONTAINEDINSPATIALSTRUCTURE('" + guid("wt-rel-contained") + "'," + oh +
        ",'Warehouse floor content',$,(" + proxies.join(",") + ")," + storey + ")"
      );
    }

    // ---- assemble the STEP physical file ----
    const lines = [];
    lines.push("ISO-10303-21;");
    lines.push("HEADER;");
    lines.push("FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');");
    lines.push(
      "FILE_NAME('" + stepString(baseName + ".ifc") + "','" + stepString(ts) + "',('" + stepString(author) +
      "'),('WarehouseTwin'),'WarehouseTwin IFC writer " + VERSION + "','WarehouseTwin " + VERSION + "','');"
    );
    lines.push("FILE_SCHEMA(('IFC4'));");
    lines.push("ENDSEC;");
    lines.push("DATA;");
    for (let i = 0; i < rows.length; i++) lines.push("#" + (i + 1) + "=" + rows[i] + ";");
    lines.push("ENDSEC;");
    lines.push("END-ISO-10303-21;");
    return lines.join("\n") + "\n";
  }

  WT.ifc = { VERSION, generate, stepString, fmt, guidFor, velocityClasses };
})();
