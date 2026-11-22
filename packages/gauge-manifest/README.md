# gauge-manifest

The strict validator for `gauge.json`, the manifest of a Gauge (Core API, v0.9.1). The core loads no Gauge before its manifest passes `validateManifest`.

## What it gives

`validateManifest(input)` takes the text or the UTF-8 bytes of one manifest. It gives `{ ok: true, manifest }` or `{ ok: false, code, reason }`. It never throws and never repeats the manifest, so a refusal never repeats a secret.

The `code` is one code of the registry in `packages/gauge-errors`. The `reason` is a stable lower-case word of the closed set `MANIFEST_REASONS`, which says the exact rule, so a test and a person can tell two refusals with the same code apart. `isManifestReason` tells whether a value is one. This package adds no code.

A check that breaks inside the validator, or an input that is not text or bytes, is the reason `internal` (still `GAUGE_MANIFEST_INVALID`). It is told apart from `syntax` on purpose, so a bug here is never reported as bad JSON.

## The order of the checks

1. Size. More than 16,384 bytes of UTF-8 is `GAUGE_MANIFEST_TOO_LARGE` (`too_large`). Exactly 16,384 passes.
2. UTF-8. Bytes that are not valid UTF-8 are `GAUGE_MANIFEST_INVALID` (`not_utf8`). A byte order mark is `syntax`.
3. Strict JSON, read by `strict-json.ts`, not by `JSON.parse`. A duplicate key (`duplicate_key`), a comment (`comment`, only a `//` or a `/*`), and a trailing comma (`trailing_comma`) are `GAUGE_MANIFEST_INVALID`. So is any other break of the format (`syntax`): any other slash, a number that is not finite (`1e999`) or longer than 400 characters, a lone surrogate written as an escape, and a nesting deeper than 16 (16 passes, 17 is refused).
4. The secret scan, over every key and every value with escapes decoded. A hit is `GAUGE_SECRET_FOUND` (`secret`). The rules are at the top of `secrets.ts`.
5. The fields, below. A Gauge that needs a Core API version this app does not offer is refused last, with `GAUGE_API_UNSUPPORTED` (`api_unsupported`).

## Fields

All fields are required except `tile` and `page`. Any other field is `unknown_field`.

- `format` is `bowerloom/gauge/1`. New formats keep the `bowerloom/` prefix until the rename. Another value is `unsupported_format`.
- `id` is lower-case words joined by single hyphens, at most 64 characters.
- `title` is 1 to 80 characters with no space at either end and no control, format, line-separator, or paragraph-separator character (so no invisible or direction-changing characters), none of the invisible fillers U+3164, U+2800, U+115F, U+1160, and U+FFA0, and at least one visible character.
- `version` is `major.minor.patch`.
- `coreApi` is a range of Core API versions, such as `>=1.0.0 <2.0.0`. See `api-version.ts`. A range that nothing can satisfy, such as `>=2.0.0 <1.0.0`, is `invalid_field`. A range that something can satisfy but not the version of this app is `api_unsupported`.
- `kind` is `ui` or `data`. The `process` and `adapter` kinds are specified and not built, so they are `unsupported_kind`.
- `protected` is a boolean.
- `engines` is a list of up to 16 engine ids, with no repeat. An empty list means the Gauge serves no engine.
- `tile` is `{ expandable, resizable, entry }`. A Gauge says whether its tile is expandable, resizable, both, or neither. A tile that is expandable needs a `page` to open.
- `page` is `{ entry }`.
- `permissions` is a list of up to 64 dotted names, with no repeat. The shape is checked first (`invalid_field`). Then each name must be in the permission list below, so a name that is well formed but not listed is `GAUGE_MANIFEST_INVALID` (`unknown_permission`). A Gauge cannot invent a permission.
- `dependencies` is a list of up to 32 `{ id, range }`, with no repeat and no Gauge that depends on itself. A range that nothing can satisfy is `invalid_field`.

A `ui` Gauge has a `tile`, a `page`, or both, and each tile has an `entry`. A `data` Gauge holds no code, so it has no `page`, and its tile has no `entry`.

## The permission list

`src/permissions.ts` is the one place that lists the permissions and gives each a one-line meaning. A permission names one thing a Gauge can read or do. The person grants permissions per Gauge version. The grants themselves live in the core (`packages/core-api`), and this package only holds the list.

Each entry has a `name`, a `kind` (`read`, `write`, or `act`), a `scope`, a `traces` flag, and a `meaning` that is one line and ends in a full stop. The list is frozen and keeps a fixed order. `PERMISSIONS` is the list, `PERMISSION_NAMES` the names, `permissionOf` reads one entry, `isPermission` and `isTracesPermission` test a value, and a prototype key such as `constructor` is never a permission.

- `read` permissions read state. `write` and `act` permissions let a Gauge ask for a plan, and never let it skip the plan: the meaning of each says so in the same words, and the person approves every plan.
- `scope` is `engine` for a permission that works only for an engine in the manifest's `engines` list, so a Gauge that lists one engine reads that engine only. It is `none` for a permission that touches no engine.
- `traces` is true for `traces.facts` and `traces.text`. Traces permissions are denied by default, granted in their own step, and revoked in one action. A Gauge that reads the text of a trace needs the facts permission too: the meaning says so, and the Traces API enforces it, not this list.
- There is no permission to react. A reaction is recorded only from the person's click on the core's reaction menu.

The names are `engines.read`, `usage.read`, `models.read`, `sessions.read`, `sessions.stream`, `sessions.start`, `sessions.stop`, `sessions.attach`, `sessions.send`, `layout.propose`, `jobs.read`, `jobs.write`, `jobs.run`, `traces.facts`, and `traces.text`. A test pins this list, so a change to it fails on purpose.

`GRANT_REASONS` is a second closed set of reasons, for a refusal of a call about grants. The core pairs it with the code `GAUGE_GRANT_MISSING` only. See `packages/core-api/README.md`.

## Origin

A manifest has no `origin`. The core sets it from where it found the folder, so a manifest that carries the field, with any value, is `GAUGE_MANIFEST_INVALID` (`origin_set_by_core`).

## Names and paths

An `id`, an engine id, a dependency id, and each segment of a `tile` or `page` entry are checked as names: a link (a URL scheme such as `https:`, or a leading `//`) is `link`, a name with two dots in a row is `dotdot_name`, and a name that starts with a dot is `hidden_name`. A Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, in any case, with or without an extension) is `device_name`. An absolute path is `absolute_path`. These five are `GAUGE_PATH_UNSAFE`. A folder name is checked by `isUnsafeFolderName`: a control, format, or separator character, a slash, or a backslash is the reason `unsafe_folder_name`, also `GAUGE_PATH_UNSAFE`. An entry path with an empty segment or a character outside letters, digits, dot, underscore, and hyphen is `invalid_field`. An entry names a file, so its last segment must end in a dot and an extension of letters and digits (`ui/tile.js`). A name with no extension is `invalid_field`. The spec does not say whether an entry may be a folder, so this package takes the stricter reading, and a test pins it.

This package checks the names inside a manifest. It does not read a folder, so a link on disk is for the code that reads the folder. The fake core of `packages/core-api` checks the folder's own name and a link flag.

## The Core API version

`CORE_API_VERSION` is the version this app offers. A range is one or two comparators joined by one space. The operators are `>=`, `>`, `<=`, `<`, and `=`.

## Fixtures

`src/fixtures.ts` holds synthetic manifests: valid ones, and one invalid one for each refusal in the ticket, plus the origin rule and the newer-API rule. The fixtures are not exported from `src/index.ts`. A test imports them from their own module. The secret fixture is built from pieces so that no file holds a whole secret-shaped value.

## Tests

`npm run test:gauge-manifest`
