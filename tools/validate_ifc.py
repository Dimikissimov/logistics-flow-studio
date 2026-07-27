#!/usr/bin/env python3
"""Gold-standard IFC validation for the WarehouseTwin export bridge (W4).

Opens a generated .ifc file with ifcopenshell (the reference open-source
IFC toolkit) and asserts schema + entity counts against the layout the
file was generated from. This is the OPTIONAL second validation layer:
verify_ifc.js already validates the file structurally without Python.

Usage:    python tools/validate_ifc.py <file.ifc> <expected-proxy-count>
Exit 0:   all checks pass
Exit 1:   a check failed
Exit 3:   ifcopenshell is not installed (the caller treats this as SKIP)

ASCII-only output.
"""
import sys


def main() -> int:
    try:
        import ifcopenshell
    except ImportError:
        print("SKIP: ifcopenshell is not installed (pip install ifcopenshell)")
        return 3

    if len(sys.argv) != 3:
        print("usage: validate_ifc.py <file.ifc> <expected-proxy-count>")
        return 1
    ifc_path, expected = sys.argv[1], int(sys.argv[2])

    # ifcopenshell.open() parses the whole STEP file and resolves the
    # schema - a malformed file raises here, which is itself the test.
    model = ifcopenshell.open(ifc_path)

    results = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(("[PASS] " if ok else "[FAIL] ") + name + ((" - " + detail) if detail else ""))
        results.append(ok)

    schema = str(model.schema)
    check("schema is IFC4", schema == "IFC4", "reported: " + schema)

    proxies = model.by_type("IfcBuildingElementProxy")
    check("one IfcBuildingElementProxy per layout element",
          len(proxies) == expected, f"{len(proxies)} proxies, {expected} expected")

    for t in ("IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey"):
        check("exactly one " + t, len(model.by_type(t)) == 1)

    check("one IfcExtrudedAreaSolid per element",
          len(model.by_type("IfcExtrudedAreaSolid")) == expected)
    check("one WT_ElementType pset per element",
          len(model.by_type("IfcPropertySet")) == expected and
          all(p.Name == "WT_ElementType" for p in model.by_type("IfcPropertySet")))

    units = model.by_type("IfcSIUnit")
    check("length unit is SI METRE",
          any(u.UnitType == "LENGTHUNIT" and u.Name == "METRE" for u in units))

    check("every proxy has placement + body representation",
          all(p.ObjectPlacement is not None and p.Representation is not None for p in proxies))

    contained = model.by_type("IfcRelContainedInSpatialStructure")
    check("all proxies contained in the storey",
          len(contained) == 1 and len(contained[0].RelatedElements) == expected and
          contained[0].RelatingStructure.is_a("IfcBuildingStorey"))

    ok = all(results)
    version = getattr(ifcopenshell, "version", "?")
    print(("OK: " if ok else "FAILED: ")
          + f"ifcopenshell {version} opened {ifc_path} ({len(list(model))} entities)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
