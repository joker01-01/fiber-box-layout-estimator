# Project State

## Goal

Deliver a local browser tool that rapidly estimates village FTTH construction quantities from customer CAD drawings while minimizing manual marking. The current priority is reliable DWG-to-DXF import, automatic household and road recognition, and a reviewable correction workflow.

## Architecture

- The app runs by opening `index.html` locally in Chrome or Edge.
- `app.js` owns canvas state, manual editing, import/export, calibration, autosave, and result presentation.
- `dxf-lite.js` parses ASCII DXF entities: `TEXT`, `MTEXT`, `LINE`, `LWPOLYLINE`, and `INSERT`.
- `core.js` converts road polylines into an intersection-split graph, attaches entrances/boxes, runs Dijkstra, greedily places boxes, and calculates route-union length and pole count.
- Customer DWG files currently require external conversion to DXF. ODA File Converter and Python `ezdxf` are available in the development environment for conversion and diagnostics.

## Current Status

Implemented:

- Manual map/image import and annotation for roads, households, entrance, existing boxes, and scale calibration.
- Greenfield and brownfield calculation modes.
- Road-graph construction, segment intersection splitting, Dijkstra routing, candidate box selection, and trunk-route union calculation.
- Handling for collinear/overlapping road segments.
- Validation for disconnected roads, distant entrance points, invalid roads, and invalid parameters.
- JSON project save/load and browser autosave.
- PNG, CSV, and schematic DXF export.
- DXF import entry point and lightweight parser.
- Recognition of `民房` labels as household points and `道路` labels as road references.
- Heuristic pairing of long horizontal/vertical road edges to produce centerline candidates.
- Recognition of `光交` or `配线层` as entrance references.
- Partial recognition of distribution-box and pole labels; CAD poles and planned boxes are displayed as references.
- Import status text tells the user to review roads and calibrate scale.

Observed but not yet accepted as reliable:

- The customer sample previously produced about 96 `民房` household points.
- The sample appears to use paired road-edge lines rather than explicit centerlines.
- The current importer immediately replaces project state after recognition; it does not yet offer confirm, cancel, or rerun controls.

## Important Decisions

- Automatic CAD recognition is the primary workflow; per-house manual marking is a correction path, not the intended starting point.
- Road names are unnecessary.
- Existing road centerlines should be preserved; paired road edges may be converted into centerlines.
- Unrelated CAD geometry must not be promoted to roads merely because it is a line entity or shares a layer.
- Imported results require human review and correction before estimation.
- Coverage distance is straight-line household-to-box distance; trunk cable follows shortest paths on the road graph.
- Existing CAD pole locations are reference-only for now. Pole quantity is recalculated as `ceil(trunk cable length / pole spacing)`.
- Browser-side direct DWG parsing is not currently supported; conversion to DXF remains the supported boundary.
- Exported DXF is an estimation schematic and is not equivalent to the customer's formal construction drawing.

## Known Problems

- The customer sample DWG/DXF import has not yet been quantitatively validated end to end in the current repository state.
- Generated road centerlines may remain disconnected where road-edge pairs end near intersections or where T/cross intersections require extension and snapping.
- The importer primarily handles axis-aligned `LINE` pairs. Angled roads, curves, arcs, block-contained geometry, and more complex polylines are not reliably recognized.
- `INSERT` entities are parsed only at a shallow level; block definitions and transformed nested entities are not expanded.
- Household recognition depends on exact normalized `民房` text. Drawings that use other labels, layers, or blocks need configurable rules.
- There is no layer-selection UI for `ROAD`, `HOUSE`, `POLE`, or `BOX` roles.
- There is no import preview transaction with confirm, cancel, or rerun recognition.
- Manual correction exists for ordinary annotations, but the workflow for correcting an automatically recognized import is incomplete.
- Scale calibration is still required after DXF import even when drawing units may already be meaningful.
- Existing versus planned distribution-box semantics need customer confirmation and stronger import controls.
- The README still describes the original manual-only scope and does not document the current DXF import workflow.

## Verification

Verified on 2026-08-31:

- `node tests/core.test.js` — passed.
- `node --check app.js` — passed.
- `node --check core.js` — passed.
- `node --check dxf-lite.js` — passed.

Not yet verified:

- Customer sample conversion and browser import in the current repository state.
- Road connected-component count and reachability from the recognized entrance.
- Count of households within the usable road-coverage distance.
- Browser interaction for import review and manual correction.
- Visual correctness of PNG and DXF output for the customer sample.

## Next

1. Convert and inspect the customer sample with ODA/`ezdxf`; record entity, layer, block, text, and geometry distributions.
2. Run the browser-equivalent recognition rules against the sample and measure household count, centerline count, graph components, entrance reachability, and household-to-road distances.
3. Add a failing regression fixture for the observed intersection-disconnection pattern.
4. Fix centerline endpoint/intersection joining with the smallest general rule supported by the sample evidence.
5. Add an import-preview transaction with confirm, cancel, and rerun recognition.
6. Add user-selectable semantic layers or rules for roads, houses, poles, and boxes.
7. Complete manual correction controls for imported households and roads.
8. Reconcile existing versus planned box semantics with the customer.
9. Update README after the sample workflow and UI behavior stabilize.
10. Consider local ODA automation for DWG only after the DXF import path is reliable.
