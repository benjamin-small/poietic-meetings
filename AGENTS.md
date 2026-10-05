# Agent instructions

## Purpose

Make focused, reviewable changes to poietic-meetings. Preserve existing behavior unless the issue or pull request explicitly authorizes a change.

## Setup

```sh
npm ci
```

## Validation

```sh
npm run typecheck
npm run test
```

## Constraints

- Do not commit credentials, generated secrets, or local environment files.
- Keep documentation and tests synchronized with behavior changes.
- Do not overwrite unrelated work in a dirty working tree.
- Merging to `main` deploys to production (`poietic-meetings` at meetings.poietic.tech) once CI passes. Work on a branch and open a pull request.
- The client in `public/` is plain JavaScript modules with no build step. Keep it that way.
- Keep the README's protocol and behavior descriptions in step with `src/room.ts` and `public/`.
