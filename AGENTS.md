# Project Instructions

## Overview

This repository is a local, single-machine browser tool for quickly estimating village-level FTTH cable construction quantities from a village map or converted CAD drawing.

The primary workflow is:

1. Import a map image or DXF converted from the customer's DWG drawing.
2. Recognize or manually correct households, roads, the village cable entrance, and existing boxes.
3. Calibrate drawing scale.
4. Place new distribution boxes and route trunk cable along the road graph.
5. Export PNG, CSV, DXF, or project JSON.

## Stack

- Static HTML, CSS, and vanilla JavaScript; no build step or server is required.
- `core.js` is DOM-independent and must remain usable from both browsers and Node.js.
- `dxf-lite.js` is a deliberately small ASCII DXF parser.
- `tools/convert-dwg.ps1` and `转换DWG.cmd` are optional Windows helpers for converting one or more DWG files through an installed ODA File Converter; the browser app must not depend on them.
- ODA File Converter may be used outside the browser to convert customer DWG files to DXF.
- Python `ezdxf` may be used for diagnostics and sample-file analysis, but it is not a runtime dependency of the web tool.

## Structure

- `index.html`, `style.css`, `app.js`: UI, canvas interaction, import workflow, project persistence, and exports.
- `cad-import.js`: DOM-free CAD semantic recognition, road-edge pairing, endpoint snapping, and guarded short-gap bridging.
- `core.js`: road-graph construction, point attachment, Dijkstra routing, box placement, quantity calculation, and CSV/DXF serialization.
- `dxf-lite.js`: parsing for the DXF entity subset required by the browser importer.
- `tests/core.test.js`: Node-based regression tests for core algorithms and basic DXF parsing.
- `tools/convert-dwg.ps1`, `转换DWG.cmd`: optional isolated DWG-to-DXF conversion workflow for Windows.

## Commands

Run from the repository root:

```powershell
node tests/core.test.js
node --check app.js
node --check core.js
node --check dxf-lite.js
node --check cad-import.js
```

For customer DWG diagnostics on the current development machine:

- ODA File Converter: `D:\cad-tools\ODAFileConverter\ODAFileConverter.exe`
- `ezdxf` version available during current development: 1.4.4

Do not make either local installation a browser runtime requirement.

## Project Rules

- Preserve the offline, local-only workflow. Do not introduce a backend or network dependency without explicit approval.
- Fast automatic recognition is the product goal. Do not make per-house manual marking the primary CAD workflow.
- Prefer the customer's DWG/DXF semantics: recognize houses and roads from layers, blocks, geometry, and labels before asking for manual work.
- Never classify every CAD line as a road. Drawing frames, house outlines, dimensions, leaders, and road edges may share layers.
- If a CAD drawing contains road centerlines, use them directly. If it contains paired road edges, attempt to derive centerlines.
- Treat `ARC` entities as road centerlines only when the user explicitly selects a road layer and centerline mode; automatic and double-edge modes may contain road-boundary fillets.
- Do not blindly expand every `INSERT` block into road geometry. Inspect block and layer semantics first; customer drawings can contain large anonymous blocks with hundreds of unrelated lines.
- Configured block-name rules use exact case-insensitive names and become authoritative for that semantic role. Keep existing-box and planned-box layers/rules separate.
- Automatic semantic recognition must exclude legend, notes, frame, and template layers for every role. An explicitly selected semantic layer is a deliberate user override and may be trusted.
- Automatic CAD recognition is provisional. Keep imported objects reviewable and manually correctable before calculation.
- Preserve provenance for inferred road geometry: keep automatic gap bridges visually distinct from CAD-derived roads through review, JSON persistence, correction, and rendered exports.
- Road names are not required.
- Cable length is the union of shortest paths along the road graph from the village entrance to box locations.
- Household-to-box coverage uses straight-line distance. Default rules are 16 households per box, 100 m coverage, and 50 m pole spacing, all user-adjustable.
- Keep the CAD household-to-road review threshold in drawing units and separate from calibrated household-to-box coverage in metres; it is an import-quality signal, not an engineering coverage rule.
- Existing CAD pole points are reference data unless the calculation semantics are explicitly changed; calculated pole count remains derived from cable length and pole spacing.
- Keep greenfield and brownfield semantics explicit. Do not silently reinterpret imported planned boxes as existing boxes.
- Direct browser parsing of DWG is out of scope for the current architecture. The supported path is DWG conversion to DXF, followed by browser import.
- DXF export is an estimation schematic, not a survey-accurate or construction-grade drawing.
- Keep exported DXF at `AC1015` with `$INSUNITS=6` because its calibrated coordinates are metres.
- Preserve existing JSON, PNG, CSV, and DXF export formats unless a requested change requires an intentional compatibility break.

## Change Safety

- Inspect import rules, their callers, and regression tests before changing CAD entity interpretation.
- Add a focused regression fixture or synthetic test for road-topology fixes before changing graph construction or snapping behavior.
- Validate sample-import quality with measurable results: entity counts, road count, connected components, reachable households/boxes, and household distance to the recognized road network.
- Keep sample-specific heuristics isolated and explain why they generalize before making them defaults.

## Protected Areas

- The customer sample DWG is source evidence. Do not modify, replace, or commit generated changes over it.
- Do not discard user-authored or uncommitted work.
