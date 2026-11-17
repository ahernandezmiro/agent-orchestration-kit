# Example Workflows

## Feature development

1. The lead reads requirements.
2. The lead writes feature spec + acceptance criteria.
3. For significant features, Astra independently reviews spec.
4. The lead revises/synthesizes.
5. The lead emits bounded implementation packet.
6. Luna implements.
7. Luna runs tests.
8. The lead reviews diff/results.
9. Astra reviews only if risk/size warrants it.

## 2D asset pipeline

1. The lead defines visual grammar, semantic SVG layers, palette/stroke constraints.
2. Astra challenges pipeline for editability/scalability/import concerns.
3. The lead locks pipeline.
4. Luna writes SVG generators/exporters/validators.
5. The lead visually reviews samples.

## 3D pipeline

1. The lead defines staged Blender production workflow.
2. Astra reviews topology/rigging/deformation/import assumptions.
3. Luna implements Blender Python helpers and validators.
4. The lead and Astra review failures only at stage boundaries.

## Video pipeline

1. The lead defines script/shot/storyboard intermediate representation.
2. Astra reviews continuity and production-control risks.
3. Luna implements Remotion components and rendering utilities.
4. The lead performs visual/story synthesis.
