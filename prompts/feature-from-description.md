---
description: Turn a natural-language feature request into a planned feature package and start the bundled workflow
---
Take this feature request and run the bundled feature workflow end to end:

$@

Expectations:
- create or update the feature package under the configured specs root
- produce a master spec, execution plan, and dependency-aware tickets
- normalize spec authoring: simple -> PRD Lite from `prd-development`; medium -> PRD-first master spec using `prd-development` + `spec-driven-workflow`; complex -> PRD-first master spec plus derived technical detail using `technical-specification`
- then continue with the next executable ticket when appropriate
