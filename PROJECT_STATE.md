# Project State

## Goal

Deliver a local browser tool that rapidly estimates village FTTH construction quantities from customer CAD drawings while minimizing manual marking. The current workflow converts DWG to DXF, previews automatic recognition, supports manual correction, calibrates scale, and then calculates quantities.

## Architecture

- The app runs by opening `index.html` locally in Chrome or Edge.
- `app.js` owns canvas state, manual editing, import-preview transactions, project persistence, exports, and result presentation.
- `dxf-lite.js` parses the browser-supported ASCII DXF subset: `TEXT`, `MTEXT`, `LINE`, `LWPOLYLINE`, `ARC`, and `INSERT`.
- `cad-import.js` is DOM-free and owns semantic recognition, layer overrides, arbitrary-angle road-edge pairing, stable endpoint clustering, guarded short-gap bridging, and household-to-road import-quality auditing.
- `core.js` builds the intersection-split road graph, attaches entrances/boxes, runs Dijkstra, places boxes, calculates route-union length and pole count, and serializes CSV/DXF outputs.
- Customer DWG files require external conversion to DXF. ODA File Converter and Python `ezdxf` are available for conversion and diagnostics.
- `转换DWG.cmd` and `tools/convert-dwg.ps1` provide an optional Windows drag-and-drop/CLI wrapper around an installed ODA File Converter. Each source is staged and converted separately; existing output files are not overwritten.

## Current Status

Implemented:

- Manual map/image annotation for roads, households, entrance, existing boxes, and scale calibration.
- Greenfield and brownfield calculation modes with adjustable coverage, capacity, and pole spacing.
- Road graph, intersection splitting, collinear-overlap handling, Dijkstra routing, candidate selection, and trunk-route union calculation.
- Validation for disconnected roads, distant entrance points, invalid roads, and invalid parameters.
- JSON project save/load and autosave; PNG, CSV, and schematic DXF export.
- DOM-free CSV generation with regression coverage for greenfield/brownfield summaries and box details. DXF exports declare R2000 (`AC1015`) and `$INSUNITS=6` so calibrated coordinates are explicitly metres.
- DXF import and recognition of `民房`, `道路`, `光交`/`配线层`, selected box labels, and pole labels.
- Parallel road-edge pairing for horizontal, vertical, and angled `LINE` entities, plus two-vertex `LWPOLYLINE` entities that are geometrically straight. Bent polylines such as house outlines remain excluded from automatic edge pairing.
- Stable multi-endpoint clustering at T/cross intersections; the sample road network now forms one graph component.
- Direction-constrained short-gap bridging for centerline fragments at straight and T intersections; inferred bridges are reported separately in the preview.
- Inferred bridges retain provenance as road indexes, render as orange dashed lines, persist in project JSON/autosave, appear in PNG rendering, and survive delete/undo without being reclassified as source roads.
- Recognition of `房屋+编号`, `村道`, `乡道`, and `街道+编号`; automatic household, road-label, entrance, box, planned-box, and pole roles consistently exclude legend/notes/frame/template layers. An explicitly selected semantic layer remains a user override.
- Import preview with confirm, cancel, and rerun recognition. Cancel restores the previous project without committing preview state.
- User-selectable road, household, existing-box, and pole layers, plus explicit automatic/centerline/double-edge road interpretation.
- A separate planned-box layer plus optional exact, case-insensitive block-name rules for households, existing boxes, planned boxes, poles, and the entrance. A configured rule is authoritative for its role and uses the `INSERT` point without expanding block geometry.
- `ARC` tessellation for an explicitly selected road layer in centerline mode. Automatic and double-edge modes leave road-layer arcs unclassified and report the ignored count in the preview, preventing boundary fillets from becoming false centerlines.
- A user-adjustable household-to-road review threshold in drawing units. The preview reports within-threshold, median, and maximum distances; outlying households receive persistent red review rings that update after road/house correction and survive project save/load.
- A delete tool for removing individual imported household points, whole road candidates, entrance, boxes, and CAD reference points, with undo support.
- Updated user documentation for the CAD workflow and current boundaries.
- An optional Windows DWG conversion helper that locates ODA through an explicit path, environment variable, or known install locations; isolates each input in a temporary job directory; emits ACAD2018 DXF; and creates a timestamped name instead of overwriting an existing output.

Customer sample diagnostics:

| Sample | Recognition options | Households | Roads | Inferred bridges | Components | Entrance | Household-to-road observation |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 和田市伊力其乡苏凯墩 | automatic | 96 | 14 | 0 | 1 | found | all 96 within 30 drawing units; max 28.617 |
| 2024XJ 辅助描汇 | `HOUSE=房屋`, `ROAD=公路`, automatic road mode | 12 | 34 | 14 | 1 | not found | all 12 within 30; max 19.822 |
| 墨玉县新奎雅车站居民区 | automatic | 93 | 17 | 2 | 1 | not found | 32 within 30; median 34.271; max 86.906 |
| 皮山县阔什塔格乡喀热苏村 | automatic | 131 | 25 | 5 | 1 | not found | 121 within 30; median 16.881; max 87.330 |

The 2024XJ sample contains 26 road-layer arcs. Visual inspection confirmed that they are double-edge corner fillets rather than road centerlines, so automatic mode intentionally ignores them, reports all 26, and continues to rely on 14 inferred bridges. The one-component result is topologically useful but still requires visual review. All three added samples omit `$INSUNITS` and therefore require manual metre calibration.

Entity-level visual review found that all 14 inferred 2024XJ bridges lie inside road-corridor intersection or corner gaps; none visibly crosses houses or unrelated geometry. In the 墨玉 sample, the previously missed upper-right road edges are long, paired two-vertex `LWPOLYLINE` entities on the same generic layer as bent house outlines. Restricting the new rule to paired straight two-vertex polylines recovered three centerlines, kept the road graph at one component, reduced the maximum household-to-road distance from 452.689 to 86.906, and did not promote bent house outlines. The remaining 61 red-ring households have no corresponding horizontal road geometry in the parsed drawing and remain deliberate review warnings rather than guessed roads.

Block diagnostics show that blind block expansion is not the next safe road-recognition step: 墨玉 has no model-space inserts, 2024XJ's two actual poles are already recovered from `P` text labels while its named pole inserts also occur in the legend, and 皮山 contains an anonymous block with 496 lines. Known/configurable symbol-name recognition should precede any guarded geometry expansion.

## Important Decisions

- Automatic CAD recognition is the primary workflow; manual marking is a review and correction path.
- Road names are unnecessary.
- Existing centerlines should be used directly when a road layer is selected with centerline mode; paired road edges may be converted into centerlines.
- Road-layer `ARC` entities are accepted only after the user explicitly selects centerline mode. They are not promoted to centerlines in automatic or double-edge mode because road-boundary fillets are common.
- Unrelated CAD geometry must not be promoted to roads merely because it is a line entity or shares a layer.
- Imported results remain provisional until the user confirms the preview and completes scale calibration.
- Inferred short-gap bridges are candidates, not authoritative CAD geometry; their provenance and distinct rendering must survive review, persistence, correction, and rendered exports.
- Household-to-road review distance is a drawing-unit import diagnostic. It must remain distinct from the calibrated metre-based household-to-box coverage rule.
- Coverage distance is straight-line household-to-box distance; trunk cable follows shortest paths on the road graph.
- Existing CAD poles remain reference-only; calculated pole count is `ceil(trunk cable length / pole spacing)`.
- Existing and planned boxes use separate layer and block-name rules. Configured block names are exact and case-insensitive, and override automatic text matching only for their own role.
- Direct browser-side DWG parsing is not supported; DWG-to-DXF conversion is the current boundary.
- Exported DXF is an estimation schematic, not a formal construction drawing.
- CSV column order remains compatible with the existing Chinese engineering summary; metre-coordinate DXF exports use `AC1015` and `$INSUNITS=6`.

## Known Problems

- DXF block definitions and transformed nested entities are not expanded; `INSERT` currently contributes only its insertion point and name.
- `ARC` road geometry is supported only for an explicitly selected road layer in centerline mode. Automatic pairing of curved double edges is intentionally not implemented; splines, ellipses, and transformed curves inside blocks remain unsupported.
- Arbitrary block names require the user to enter the exact names in the advanced import rules; road geometry inside blocks is still intentionally not expanded.
- A selected road layer is trusted more strongly and may still contain non-road geometry; preview and manual deletion remain required.
- The default 30 drawing-unit household-to-road review threshold matches the four current samples but remains user-adjustable; it is not a universal physical-distance rule.
- Scale calibration is required after DXF import. The original sample declares millimetres in `$INSUNITS`, while all three added samples omit `$INSUNITS`; neither case safely establishes a metre scale.
- Existing versus planned distribution-box semantics still need customer confirmation for drawings with ambiguous labels/layers.
- Direct local ODA automation for DWG is not integrated into the static browser app.
- The optional conversion helper still requires a separately installed ODA File Converter and cannot be invoked directly by browser JavaScript because of the browser security boundary.

## Verification

Verified on 2026-08-31:

- `node tests/core.test.js` — passed, including sample-derived intersection connectivity, layer overrides, explicit centerline mode, angled road-edge pairing, DXF `ARC` parsing/tessellation, and the automatic-mode arc guard.
- `node --check app.js` — passed.
- `node --check core.js` — passed.
- `node --check dxf-lite.js` — passed.
- `node --check cad-import.js` — passed.
- Customer sample conversion and module-level recognition metrics listed above — passed.
- Three additional customer DWGs converted with ODA and analyzed with `ezdxf` plus the browser-equivalent parser; the recommended recognition options and metrics are listed above.
- Regression coverage for numbered-house/road-label variants, legend entrance exclusion, and direction-constrained straight/T-gap bridging — passed.
- Local browser page load, sample preview rendering, displayed sample counts, and cancel/restore behavior — visually verified.
- Isolated Chrome browser regression for the 2024XJ sample — passed: `HOUSE=房屋`, `ROAD=公路`, automatic road mode produced 12 households, 34 roads, one component, and 14 inferred bridges; orange dashed rendering contained 1,545 matching pixels.
- Browser confirm, autosave, refresh/restore, inferred-road deletion, and undo — passed; inferred bridge count changed 14 → 13 → 14 and road count changed 34 → 33 → 34.
- Four-sample batch recognition assertions — passed with the exact counts and distance metrics in the diagnostics table; inferred-road index counts match bridge statistics for every sample.
- Four-sample batch recognition after `ARC` support — passed with unchanged automatic-mode metrics. The 2024XJ preview reports 26 ignored road-layer arcs.
- Isolated Chrome regression for `ARC` behavior — passed: 2024XJ automatic mode retained 12 households, 34 roads, 14 inferred bridges, and one component while reporting 26 ignored arcs; forced centerline mode tessellated 26 arcs and displayed the resulting 11-component warning.
- Household-to-road audit regression — passed for per-house distances, threshold classification, no-road handling, and immediate clearing after a corrective road is added.
- Four-sample audit at the default 30 drawing-unit threshold — passed: 和田 96/96 within threshold, 2024XJ 12/12, 墨玉 30/93, and 皮山 121/131; road and bridge counts remained unchanged.
- Reference-layer isolation regression — passed for households, road labels, existing/planned boxes, and pole labels while preserving explicit layer overrides.
- Four-sample semantic-role regression after reference-layer isolation — passed with unchanged households, roads, bridges, poles, boxes, entrances, and far-household counts. 2024XJ automatic recognition already returns its two actual pole references, so no sample-specific block-name rule was added.
- CSV export regression — passed for UTF-8 BOM, greenfield/brownfield summaries, existing/new box rows, cable quantities, and detail columns; Python's standard CSV parser read the generated 17-row fixture and four box rows.
- DXF export validation with `ezdxf` 1.4.4 — passed: version `AC1015`, `$INSUNITS=6`, expected six populated semantic layers, 7 lines, 30 points, 4 circles, and 4 text entities in the synthetic calibrated project.
- Configurable block-rule regression — passed for comma/semicolon parsing, exact case-insensitive matching, reference-layer isolation, authoritative per-role behavior, and separate existing/planned box layers and semantics.
- 2024XJ block-rule validation — passed: `原有木杆` returns the two actual engineering-layer pole inserts while same-name legend inserts, the legend distribution box, and the legend exchange box remain excluded. All four samples retain their default metrics.
- Two-vertex `LWPOLYLINE` edge-pairing regression — passed: a synthetic straight pair generates one centerline, a bent three-vertex house outline is excluded, and a mixed `LINE`/polyline fixture does not steal an existing `LINE` pair.
- Four-sample regression after straight-polyline edge support — passed: 和田 96 households/14 roads/1 component, 2024XJ 12/34/1, 墨玉 93/17/1, and 皮山 131/25/1. The other three samples retained their earlier road, bridge, and distance metrics; 墨玉 improved to 32 households within 30 drawing units with median 34.271 and max 86.906.
- Windows PowerShell 5.1 conversion-helper syntax — passed. An end-to-end ODA conversion of the 墨玉 DWG produced a browser-readable DXF with 291 parsed entities and unchanged recognition metrics (93 households, 17 roads, 2 bridges, 61 review households). A second run created a timestamped DXF and preserved the first file.

Not yet verified:

- Final box placement and PNG/CSV/DXF export visuals for the customer samples, because trustworthy metre calibration and entrance locations have not been supplied for the three added drawings.
- Browser interaction for the review-threshold/red-ring UI, advanced block-rule controls, and JSON round trip was not completed because the in-app browser runtime failed to connect with a local `EPERM` permission error. Algorithm, syntax, and four-sample checks passed.

## Next

1. Complete browser interaction regression for the new review-threshold input, red-ring rendering, correction refresh, and JSON round trip when the in-app browser connection is available.
2. Manually mark the entrance and calibrate a trustworthy known distance for each added sample.
3. Run greenfield and brownfield calculations on reviewed samples and inspect PNG/CSV/DXF outputs.
4. Confirm existing-versus-planned box semantics with the customer.
5. Add guarded block-definition expansion, spline/ellipse, or paired curved-edge support only when customer samples require it.
