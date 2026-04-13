---
description: Turn a natural-language feature request into a planned feature package and start the bundled workflow
---
Take this feature request and run the bundled feature workflow end to end:

$@

Expectations:
- create or update the feature package under the configured specs root
- produce a master spec, execution plan, and dependency-aware tickets when the feature is ready for refinement
- normalize spec authoring: simple -> PRD Lite from `prd-development`; medium -> PRD-first master spec using `prd-development` + `spec-driven-workflow`; technically complex -> write the master spec first, then stop and ask the user to add `04-technical-design.md` before refinement continues
- then continue with the next executable ticket when appropriate
