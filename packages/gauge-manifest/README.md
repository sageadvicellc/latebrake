# gauge-manifest

The strict validator for `gauge.json`, the manifest of a Gauge (Core API, v0.9.1). The core loads no Gauge before its manifest passes `validateManifest`.

## What it gives

`validateManifest(input)` takes the text or the UTF-8 bytes of one manifest. It gives `{ ok: true, manifest }` or `{ ok: false, code, reason }`. It never throws and never repeats the manifest, so a refusal never repeats a secret.

The `code` is one code of the registry in `packages/gauge-errors`. The `reason` is a stable lower-case word for the exact rule, so a test and a person can tell two refusals with the same code apart. This package adds no code.

## The order of the checks

1. Size. More than 16,384 bytes of UTF-8 is `GAUGE_MANIFEST_TOO_LARGE` (`too_large`). Exactly 16,384 passes.
2. UTF-8. Bytes that are not valid UTF-8 are `GAUGE_MANIFEST_INVALID` (`not_utf8`). A byte order mark is `syntax`.
3. Strict JSON, read by `strict-json.ts`, not by `JSON.parse`. A duplicate key (`duplicate_key`), a comment (`comment`), and a trailing comma (`trailing_comma`) are `GAUGE_MANIFEST_INVALID`. So is any other break of the format (`syntax`), and a nesting deeper than 16.
4. The secret scan, over every key and every value with escapes decoded. A hit is `GAUGE_SECRET_FOUND` (`secret`). The rules are at the top of `secrets.ts`.
5. The fields, below. A Gauge that needs a Core API version this app does not offer is refused last, with `GAUGE_API_UNSUPPORTED` (`api_unsupported`).

## Fields

All fields are required except `tile` and `page`. Any other field is `unknown_field`.

- `format` is `bowerloom/gauge/1`. New formats keep the `bowerloom/` prefix until the rename. Another value is `unsupported_format`.
- `id` is lower-case words joined by single hyphens, at most 64 characters.
- `title` is 1 to 80 characters with no control character and no space at either end.
- `version` is `major.minor.patch`.
- `coreApi` is a range of Core API versions, such as `>=1.0.0 <2.0.0`. See `api-version.ts`.
- `kind` is `ui` or `data`. The `process` and `adapter` kinds are specified and not built, so they are `unsupported_kind`.
- `protected` is a boolean.
- `engines` is a list of up to 16 engine ids, with no repeat. An empty list means the Gauge serves no engine.
- `tile` is `{ expandable, resizable, entry }`. A Gauge says whether its tile is expandable, resizable, both, or neither. A tile that is expandable needs a `page` to open.
- `page` is `{ entry }`.
- `permissions` is a list of up to 64 dotted names such as `engines.read`, with no repeat. The shape is checked here. Which names exist, and the grants, belong to the grants ticket.
- `dependencies` is a list of up to 32 `{ id, range }`, with no repeat and no Gauge that depends on itself.

A `ui` Gauge has a `tile`, a `page`, or both, and each tile has an `entry`. A `data` Gauge holds no code, so it has no `page`, and its tile has no `entry`.

## Origin

A manifest has no `origin`. The core sets it from where it found the folder, so a manifest that carries the field, with any value, is `GAUGE_MANIFEST_INVALID` (`origin_set_by_core`).

## Names and paths

An `id`, an engine id, a dependency id, and each segment of a `tile` or `page` entry are checked as names: a link (a URL scheme such as `https:`, or a leading `//`) is `link`, a name with two dots in a row is `dotdot_name`, and a name that starts with a dot is `hidden_name`. An absolute path is `absolute_path`. These four are `GAUGE_PATH_UNSAFE`. An entry path with an empty segment or a character outside letters, digits, dot, underscore, and hyphen is `invalid_field`.

This package checks the names inside a manifest. It does not read a folder, so a link on disk is for the code that reads the folder. The fake core of `packages/core-api` checks the folder's own name and a link flag.

## The Core API version

`CORE_API_VERSION` is the version this app offers. A range is one or two comparators joined by one space. The operators are `>=`, `>`, `<=`, `<`, and `=`.

## Fixtures

`src/fixtures.ts` holds synthetic manifests: valid ones, and one invalid one for each refusal in the ticket, plus the origin rule and the newer-API rule. The fixtures are not exported from `src/index.ts`. A test imports them from their own module. The secret fixture is built from pieces so that no file holds a whole secret-shaped value.

## Tests

`npm run test:gauge-manifest`
