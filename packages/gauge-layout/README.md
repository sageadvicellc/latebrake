# gauge-layout

The layout of the bento home (Core API, v0.9.1): the grid, the layout file with its revisions, export and import, the way back, the default home, and the changes a person can make. It is pure code. The Core API client suite in `packages/core-api` is the seam: the fake core and the real core both use this package, and the layout suite runs against either.

A person arranges the layout. A Gauge never does. Every change goes through a plan that the person approves (see "The plan of a change"), and a Gauge may only propose to add itself.

## The grid

6 columns, a unit of 200 px, and a gap of 12 px. The full home is 6 units and 5 gaps, 1,260 px wide (`FULL_WIDTH_PX`). A tile is as big as its size, in units:

| size | width x height |
|---|---|
| `small` | 1 x 1 |
| `medium` | 2 x 1 |
| `large` | 2 x 2 |
| `full` | every column (6) x 2 |

A tile has a column and a row, counted from 0. It must end inside the grid: `col + width <= 6`, so a `full` tile is at column 0. The home has at most 32 rows (`MAX_ROWS`), so `row + height <= 32`. Two tiles may not share a cell. Tiles that only touch are fine.

A window too narrow for 6 columns drops columns. `columnsFor(width)` gives the number of columns that a window of that width in px has: n columns need `212 n - 12` px, so 1,260 gives 6, 1,259 gives 5, 1,048 gives 5, and 1,047 gives 4. It is never less than 1, and a width that is not a number gives 1. `spanOn(size, columns)` gives how many of those columns a tile covers: its own width, and no more than the columns that the window has. The file does not change, so a layout stays valid in a narrow window.

## What a Gauge allows

A Gauge's manifest says whether its tile is resizable and may list size hints (`tile.sizes`, see `packages/gauge-manifest`). `tileInfoOf` turns that into the sizes the tile allows, the first one preferred:

- With hints, the allowed sizes are the hints.
- With no hints, a resizable tile allows every size, and a tile that cannot be resized allows `small` only.
- A tile that cannot be resized has exactly one allowed size.

A layout may only use a size that its Gauge allows (`size_not_allowed`), and a tile whose Gauge cannot be resized may not be any other size than its one (`not_resizable`).

## The layout

A layout is strict JSON in UTF-8, with these fields and no others (`format` is `bowerloom/layout/1`; new formats keep the `bowerloom/` prefix until the rename):

- `format`.
- `grid`: `{ columns: 6, unit: 200, gap: 12 }`. Any other value is `unsupported_grid`.
- `tiles`: the places on the home. A tile is `{ place, gauge, default, col, row, size }`. `place` is the name of a spot, and it stays when the Gauge in it is swapped. `gauge` fills the place now. `default` is the Gauge that the place goes back to. `size` is one of the four names.
- `shelf`: the Gauges and pages that are one step away.
- `hidden`: the Gauges that the person hides.

Every name (a place, a Gauge id) is lower-case words joined by single hyphens, at most 64 characters. Any other value, or a value that is not text, is `invalid_field`. A column or row must be a whole number that a computer holds exactly: a fraction, a number past 2^53, `-0`, and a value that is not a number are `invalid_field`. A negative or too large whole number is `out_of_grid`.

### Caps and the order of the checks

The text is at most 32,768 bytes (`MAX_LAYOUT_BYTES`, exactly the cap passes). A text that is longer than the cap in characters is refused before it is encoded, since every character takes at least one byte, so a huge text is never copied first. A layout has at most 48 tiles (`MAX_TILES`) and at most 100 names on the shelf and 100 on the hidden list (`MAX_LISTED`). The longest layout that these caps allow is 26,050 bytes, which a test pins, so a core never refuses a layout it wrote. A layout of 10,000 tiles is refused by the size cap before any tile is read. A list over its cap is refused before any element is read.

The checks run in this order, and the first that fails refuses, with `GAUGE_LAYOUT_INVALID` and a reason, except the last stage:

1. The size cap (`too_large`), then UTF-8 (`not_utf8`), then strict JSON: a duplicate key (`duplicate_key`), a comment (`comment`), a trailing comma (`trailing_comma`), and any other break of the format, including a byte order mark (`syntax`).
2. The fields: an unknown field (`unknown_field`, which includes `__proto__`), a missing field (`missing_field`), the format (`unsupported_format`), the grid (`unsupported_grid`), a size that is not one of the four (`unknown_size`), and the caps (`too_many_tiles`, `too_many_listed`).
3. No place twice (`duplicate_place`), and no Gauge twice across the tiles, the shelf, and the hidden list, and no default twice (`duplicate_gauge`).
4. Every tile is in the grid (`out_of_grid`), then no two overlap (`overlap`).
5. Against the Gauges the core holds, for a layout that is read for the core: every Gauge id exists (`unknown_gauge`) and is enabled (`gauge_disabled`), and a place is filled by a Gauge that has a tile (`no_tile`). Then every size is allowed (`size_not_allowed`, `not_resizable`).
6. The way back, with `GAUGE_PROTECTED` (see below).

## The way back

The Gauge manager and Settings can never be hidden, removed, or replaced. Settings is a core page and not a Gauge. It is modelled as a protected entry, `settings` (`PAGE_IDS`), that has no tile and must always have a reachable place on the shelf. No Gauge may install under that id (`GAUGE_NAME_RESERVED`). A Gauge is protected when the core says so: the stock Gauges Harnesses and the Gauge manager are.

A layout is refused with `GAUGE_PROTECTED` and one of three reasons:

- `hidden`: a protected Gauge, or `settings`, is on the hidden list.
- `replaced`: a place holds another Gauge than the protected Gauge it is for. A place is for a protected Gauge when the file says so (`default`), and also when the place is one of the five places of the default home that the core holds for a protected Gauge (`DEFAULT_TILES`). The file cannot vouch for itself: a text that changes both the `gauge` and the `default` of the `harnesses` place is still `replaced`.
- `removed`: an enabled protected Gauge, or `settings`, is on no tile and not on the shelf.

The shelf counts as a reachable place, so a protected Gauge may sit on the shelf and not on the home. The default layout does this for the Gauge manager. A person may also take Harnesses off the home by dropping its tile, and it then sits on the shelf. This is decided: Harnesses may leave the home for the shelf, and the shelf counts as reachable for every protected Gauge.

A change that would do the same is refused the same way. A swap that would take a protected Gauge out of its place is `replaced`. Settings has no place that a Gauge can fill, so there is nothing to replace: the ways to break its rule are to hide it and to drop it.

## The default home

`defaultLayout(table)` is the five tiles of the spec's home, in this arrangement (they fill the first two rows exactly): Engines and usage (large, column 0, row 0), Jobs (large, column 2, row 0), Harnesses (medium, column 4, row 0), Local models (small, column 4, row 1), and Memory explorer (small, column 5, row 1). Every other enabled Gauge, with `settings`, is on the shelf, so Projects, Library, Tracing, and the Gauge manager are one step away. The place names are `engines`, `jobs`, `harnesses`, `models`, and `memory`.

A default Gauge that the core does not hold, that is disabled, or whose tile does not allow its size is left off the home and goes on the shelf. The result is a valid layout for any set of Gauges. `HOME_GAUGES` lists the nine stock Gauges of v0.9.1 with what each tile allows.

## The canonical form and export

The canonical text is one line of compact JSON with the fields in the order above, tiles in the order of row, then column, then place, the shelf and the hidden list sorted by code unit, and one line feed at the end. The same layout always gives the same bytes. An import accepts any order and sorts it, and accepts white space between tokens. `canonicalText` writes it, and an export is exactly that text. Export then import gives the same layout, in the same bytes.

## The file and its revisions

The saved file has the format `bowerloom/layout-file/1`:

```
{ "format": "bowerloom/layout-file/1", "revision": 12, "current": <layout>, "revisions": [ { "revision": 11, "layout": <layout> }, ... ] }
```

- `revision` is the number of the current layout, from 1. Each change that changes the layout adds 1. The number is never reused. The last number is 999,999,999: a file at that number takes no more changes (`bad_revision`).
- `revisions` are the earlier layouts, newest first, at most 10 (`MAX_REVISIONS`). Their numbers fall, and all are below the current number (`bad_revision`). A save pushes the current layout to the front, and the 11th drops the oldest. The current layout is never in the list, so dropping the oldest never loses it.
- A layout that is the same as the current one writes no revision.
- The text is at most 11 layouts of the largest size and 4,096 bytes more (`MAX_FILE_BYTES`, 364,544).
- On reading, the current layout is checked against the Gauges as in stage 5 and 6 above. The revisions are checked for their shape and their grid only, because a revision may name a Gauge that is gone now. A revision is checked against the Gauges when it is restored.
- More than 10 revisions is `too_many_revisions`.

## Safe mode

A broken file, or a file whose current layout is invalid or no longer fits the Gauges, never blocks the start. The core starts in safe mode: the layout in use is the default layout, `revision` is 0, the revisions are empty, and the core reports why, with the exact code and reason that the file got. A value that is not text or bytes is not a file, and is `syntax`. Nothing is written. The broken file stays on disk until the person makes a change.

The first change saves the layout as revision 1 in a new file, and that leaves safe mode. The plan says so: `leave safe mode, keep the saved file as a backup, and save the layout as revision 1`. The core keeps the raw bytes of the saved file as a backup, byte for byte, and not a decode of them. Revisions are not salvaged from a broken file, so the backup is the way to get them back. This package does not write files, and a real core must keep the backup on disk.

A start that breaks inside the reader, and not in the file, is the reason `internal`. It could be a bug and not a broken file, so every change is refused with `GAUGE_LAYOUT_INVALID` and `internal` while it lasts, and nothing can overwrite the file.

## The changes a person can make

Each is a pure function that builds a new layout and never edits the one it was given. A result is checked as a whole against the grid and the Gauges.

- `swapPlace(layout, table, place, gauge)`: another Gauge fills a place. The place keeps its position and default. The new Gauge keeps the size of the place if its tile allows it. Otherwise the sizes it allows are tried in the order of its manifest. Each size is tried against the grid, and the first that fits is taken. When none fits, the swap is refused with `no_room`, and any other cause (a protected Gauge, a Gauge used twice) is given as it is. The displaced Gauge goes to the shelf. The new Gauge leaves the shelf or the hidden list. A Gauge that already fills a place is `duplicate_gauge`. A swap to the Gauge already there changes nothing. A place that is not there, or is not text, is `unknown_place`, and a Gauge that is not there, or an id that is not text, is `UNKNOWN_GAUGE`.
- `defaultPlace(layout, table, place)`: the default Gauge of a place is one action away, and this puts it back. It changes nothing when the place already holds it. When the default Gauge is on the shelf or hidden, it is a swap. When it fills another place, the two places exchange their Gauges, so the default is back in its own place and the other place holds what was here. Each Gauge keeps its place's size when it allows it, and otherwise takes the first size it allows that fits, else the action is refused with `no_room`.
- `proposeTile(layout, table, gauge)`: a Gauge asks to add itself. It gets a tile of its first allowed size in the first free cell (by row, then column), in a place named `place-<n>` with the smallest free number. It is refused with `duplicate_gauge` when it already has a tile, `too_many_tiles` at the cap, and `no_room` when no cell is free.

## A lifecycle step keeps the layout in line

A step that changes the Gauges (disable, remove, update, enable) reconciles the layout inside the same approved plan, and saves the result as a normal revision, so the saved layout never goes stale and every later change still works. `reconcileLayout(layout, table)` does this, and never edits the layout it was given:

- A Gauge that is disabled, removed, or has lost its tile leaves its tile. The place goes back to its default Gauge when that Gauge is enabled, has a tile, is not hidden, is not on another tile, and has a size that fits: the size of the place first, then the order of its manifest. Otherwise the tile is dropped, since the format has no empty place. A dropped tile stays gone. A restore of an earlier revision brings it back, and a swap puts the Gauge on another place. A Gauge that is enabled and only lost its tile goes to the shelf.
- A tile whose Gauge no longer allows its size takes the first allowed size that is no bigger than the tile and that fits, in the same cell. A step never makes a tile grow in that case. When none fits, the Gauge goes to the shelf.
- A place that is for a protected Gauge (its default became protected, or it is a place of the default home for one) and that another Gauge fills gives the place back. A protected Gauge on the shelf takes the place, with itself as the default, and the Gauge that was there goes to the shelf. A protected Gauge on another tile exchanges places with it. When neither fits, the tile is dropped and the Gauge that was there goes to the shelf.
- A default Gauge that is gone becomes the Gauge in the place, and two places never share a default.
- A Gauge that is disabled or removed leaves the shelf and the hidden list. `settings` stays.
- A protected Gauge that is enabled and on no tile goes to the shelf, also from the hidden list, so a newly enabled protected Gauge appears there. A protected Gauge is never dropped.
- A Gauge that a step just enabled (`options.enabled`) and that is on no tile, shelf, or hidden entry goes to the shelf. So a Gauge that is disabled and enabled again, or installed and enabled for the first time, is not lost. An enabled Gauge that the layout does not hold, in any other step, is left alone.
- A hidden Gauge stays hidden. It does not come back on a tile when a place has it as its default.

The result is valid for the Gauges. A case that these rules do not foresee throws a plain `Error`: there is no fallback to the default layout, so a bug fails loudly, and the step throws before it changes anything. A fuzz test of 3,000 random layouts and Gauge changes, including protect flips, holds this (a run of 60,000 found no case). The plan of the step says what changes, in lines that start with `layout: `, one for every difference, and none when the layout does not change.

## Reasons

`sha256Hex` is a pure SHA-256, so that the client seam needs no platform module. `LAYOUT_REASONS` go with `GAUGE_LAYOUT_INVALID`, and `PROTECTED_REASONS` (`hidden`, `removed`, `replaced`) go with `GAUGE_PROTECTED`. Both are closed sets, and a reason never holds a value that a caller sent. This package adds no code to the registry in `packages/gauge-errors`.

## What is not covered

- Who calls the change calls. The fake core trusts the Gauge id of a proposal. The per-Gauge channel and token belong to the call identity work.
- A file on disk, and a crash while it is written. The fake core keeps the file text in memory. A real core must write the file in one step, and must keep a copy of a broken file.
- Drag and drop, resize handles, and drawing. Those are the app's. This package says what is valid.
- Fascia. A Fascia never changes the layout.

## Tests

`npm run test:gauge-layout`
