# The seawater calculator

`packages/teos10` and the page at `/data/seawater/` that presents it.
Moved out of the root `CLAUDE.md`, which keeps what applies across the site —
including the rule that every tool page carries a disclaimer, and the note on
why the language on these pages is factual rather than instructive.

The second thing on this site with a package behind it, and the split is the
map's: `packages/teos10` decides what is true, `SeawaterCalculator.astro`
decides what it looks like. It imports no DOM, no framework and no renderer,
so `test:teos10` calls it directly through Node's type stripping — no build,
no jsdom, no fixtures beyond one JSON file.

**It is not a map, and `test:map` had to be told so.** That harness carries a
named list of everything under `packages/` and fails on an unlisted one,
precisely so a new package is a decision rather than an oversight. `teos10` is
listed as *not a map*, which is what exempts it from the palette, pane and
`dataBase` rules that would make no sense for it.

## Why the Gibbs function rather than the polynomial

GSW evaluates most properties from a 75-term polynomial fitted to specific
volume — fast, accurate to about a part in 10⁶, and the right default for a
model. This evaluates the **Gibbs function itself** (IAPWS-09 for pure water,
IAPWS-08 for the salt) and takes the analytic derivatives, so density is
`1/g_P` and sound speed, heat capacity, entropy and the expansion
coefficients are two or three symbols of the same function. Every property is
then thermodynamically consistent with every other one *by construction*
rather than to within a fit's residual, which is the whole claim a calculator
makes.

It costs nothing measurable. `evaluate()` — fifty-one properties, several of
them iterative — is **36 µs**, so a keystroke is not where the time goes.

The freezing point additionally needs IAPWS-06, the Gibbs function of ice,
because it is the temperature where the chemical potential of water in
seawater equals that of ice. That is the one place the two standards meet, and
`gibbs-ice.ts` is complex-valued where everything else is real — the imaginary
parts cancel, but only at the end. Six inline operations rather than a
complex-number dependency, by the same argument `kmz.ts` makes about ZIP
libraries.

## The coefficients are transcribed by machine, and must stay that way

There are about two thousand numeric literals in `gibbs.ts`. A mistyped digit
changes an answer by an amount no reviewer can see and no reader would
question — the silent-wrong-number failure this project keeps paying for — so
**none of them was typed**. They are converted by rule from GSW-C's
`gsw_oceanographic_toolbox.c`; the arithmetic is untouched and only the syntax
around it changes.

`npm run test:teos10` has three kinds of check and the second does the work:

- **Against the reference.** Every function at twenty-four points spanning the
  domain and sitting on its edges — zero salinity where `sqrt(SA)` is singular
  and the `log(x)` guard switches, the freezing point, 10,000 dbar, 42 g/kg —
  compared with GSW to 1e-11.
- **Against calculus.** Every derivative branch against a central difference
  of the branch below it, over a few thousand states. `g_TT` has to be the
  temperature derivative of `g_T`, and `g_T` of `g`, so a wrong digit breaks
  the chain wherever it sits. **This needs no reference implementation at
  all**, which is what lets it cover the space the fixture cannot: twenty-four
  points is coverage of the *branches*, not of the domain.
- **Against physics.** Pure water densest at 3.98 °C, Standard Seawater
  freezing at −1.919 °C, sound at 1534 m/s. These would miss a subtle error
  and catch a catastrophic one, which is what they are for.

**A fixture rather than a dependency.** CI here installs one Python package
for one pipeline; adding a second so a JavaScript test can run is the wrong
shape. `scripts/make-teos10-fixture.py` records GSW's answers once, 24 KB, and
`scripts/test-teos10.mjs` checks them with no network and no Python.

**Mutation-tested, and the limit is worth stating.** A transposed pair of
digits ten places into a coefficient, a dropped digit, a flipped sign, the
`log` guard disabled, a constant off in its last digit, a sign error in the
ice arithmetic and the whole atlas zeroed are all caught. A change in a
coefficient's *last* digit is **not**, and no threshold could see it: 1e-15 of
a coefficient multiplied by a normalized pressure moves the answer less than
the order the terms are summed in does.

Two things had to be got right in the tolerance, both learned by getting them
wrong. Several of these quantities pass through zero — the Gibbs function is
1.4e-6 J/kg at one sample, from terms of 1e5 — so a purely relative tolerance
reports the last bit of a double as a 1e-10 error; small values are judged
against the scale of the list they sit in. And the differencing check's own
scaling was inverted on the first attempt: `gibbs` returns pressure
derivatives **per pascal** while its argument is in decibars, so a difference
taken in decibars is 1e4 too large. Multiplying instead of dividing gives
exactly 1e8, which is how it was caught.

## `tMaxDensity` is solved exactly, and deliberately disagrees with GSW

Density is greatest where thermal expansion vanishes, and α is `g_TP / g_P`
with `g_P` the specific volume — strictly positive. So the maximum is the root
of `g_TP` alone, which this package has to machine precision, and no
approximation of α need enter. It is found by bisecting a 90-degree bracket,
which cannot land on the wrong root because `g_TP` rises through zero once.

GSW solves the same thing from the 75-term polynomial's α, and **deep down
that is outside its funnel**: at SA 42 and 10,000 dbar the state it returns
has an exact thermal expansion of −1.5e-4 rather than zero, and the two
answers are 8 °C apart. So the gate compares them only above 1000 dbar, where
they agree to a few hundredths, and separately asserts the exact statement —
that α vanishes at the answer — over the whole grid to 1e-15. Comparing deep
would be asserting that this package reproduces an extrapolation error.

**The bracket has to reach a long way below zero**, and the first one did not:
the maximum is near 4 °C for fresh water at the surface and about −33 °C at
10,000 dbar, well below the freezing point. That is not a bug in the answer —
it is what says the maximum is unreachable rather than merely cold.

## The Absolute Salinity Anomaly atlas

TEOS-10's headline change over EOS-80 is that density depends on what the salt
is *made of*, not only on how much conductivity it carries. That correction
was **measured, not derived**, and lives in a global lookup table — so
`SA_from_SP` needs a longitude and a latitude, and a file. A TEOS-10
calculator without it would be missing the point of TEOS-10.

It reaches **0.03 g/kg in the North Pacific**, which is about 0.024 kg/m³ of
density — thirty times the precision anyone quotes it to, and invisible unless
you apply it.

**Resampling it is not an option, and that was measured before the work
started.** Sampling GSW's own `SAAR` onto its 4° lattice and re-interpolating
naively gives a worst error of **0.069 g/kg and a p99 of 0.0087** — larger
than the anomaly it is trying to represent, because GSW's answers at the
lattice nodes already include its barrier and mean-fill handling and
re-interpolating those compounds them.

So the real table is recovered. It is not distributed as data — GSW compiles
it into its extension module — so `scripts/make-saar-atlas.py` finds it by
searching for the exact bytes of the longitude axis, an unmistakable run of 91
doubles from 0 to 360 in fours, with the latitude axis, the seafloor level
counts and the anomaly table following it. **That is a guess until it is
checked, and the check is the point**: the script reimplements the GSW lookup
on what it extracted and compares against `gsw.SAAR` at 30,000 random
positions, refusing to write unless they agree. Measured on gsw 3.6.20:
**2.2e-19**, which is summation order.

**Stored as int16 at a 1e-7 quantum**, which is 3.5e-6 g/kg in Absolute
Salinity — four orders below the last digit the page prints, and half the size
of float32. 365 KB raw, **188 KB gzipped**.

**Gzipped on disk and inflated in the browser**, because a static host does
not compress an unknown binary type: measured on this one, SVG comes back
`content-encoding: gzip` and PNG does not. `DecompressionStream('gzip')` is
the same mechanism the map uses for a KMZ. A host that *does* decompress it
transparently would hand us plain bytes, so the gzip magic is sniffed rather
than assumed — two bytes of checking removing a whole class of "works here,
not there".

**Fetched only when a position is entered**, and latched so a reader typing a
longitude digit by digit does not pull 188 KB per keystroke. `test:seawater`
asserts both halves; without the latch it reads three requests.

**The lookup is GSW's own algorithm, barriers and all.** The Panama polyline
matters: two lattice cells either side of Central America are different
oceans, and interpolating across would carry Caribbean water into the Pacific.

## The one promise the package makes beyond arithmetic

**It never reports Reference Salinity under Absolute Salinity's name.** With
no position, or outside the atlas, `SA` is `SR` — and `evaluate` says so in
its notes, which the page shows. Reporting the right number silently is
exactly the failure: the difference is the entire reason TEOS-10 replaced
EOS-80, and it is invisible on screen.

`test:seawater` checks both halves, the number *and* the sentence, because a
page that got the number right and dropped the sentence would look correct.

It reports out-of-range rather than clamping, for the same reason: outside 0
to 42 g/kg, the freezing point to 40 °C and 0 to 10,000 dbar the polynomials
still return numbers, and those numbers are an extrapolated fit rather than
seawater.

## The page

**It renders its default state at build time.** The fifty-one rows are real
HTML in the deployed page, so it arrives with a worked example on it and
nothing shifts when the script loads. That costs one duplicated render — the
loop in the Astro template and `paint()` in the script — which is why
`test:seawater` asserts that a repaint at the shipped inputs changes not one
cell.

Bugs worth not repeating, all found by looking rather than by a gate:

- **Every stroked SVG path needs `fill: none`.** A path fills by default, so
  the two-legged axis rendered as a solid black triangle across the diagram.
  It shipped that way for one browser check. `test:seawater` reads the built
  stylesheet for it, because jsdom does no layout and cannot see a filled
  triangle.
- **The batch parser split on "commas *or* whitespace".** At `35.0, 10.0` that
  matches the comma *and* the space, leaving an empty token whose `Number()`
  is **0, not NaN** — so every column shifted one left and the reader got
  plausible numbers for water they never described. Comma-space is the
  commonest paste there is, and it was the one that broke. One character class
  and a `filter(Boolean)`.
- **The gravity row said only "Gravity".** It varies half a percent from the
  equator to the pole and the page falls back to the equator when no position
  is given, so the label carries the latitude now. The `label written once,
  describing a value that varies` shape from the list in the root `CLAUDE.md`,
  met again.

## What the page remembers, and the order it believes things in

The inputs are kept in `localStorage`, so a return visit opens where the last
one left off. Not `sessionStorage`: the promise is "next time", which is a
different one from the map's saved view, and it is the same store the theme
toggle uses so clearing site data clears both.

**A link outranks the memory, which outranks the defaults, and that order is
load-bearing.** Someone sends you a view and you have to see *theirs* — a
stored state quietly winning would make the link feature untrustworthy in the
one case it exists for. Same precedence the map settled on.

**The whole input state, not only the two fields asked for.** Remembering
salinity and temperature but resetting pressure would hand back a hybrid
nobody was looking at, and dropping the position would silently turn the
Absolute Salinity they left with back into Reference Salinity — which is
precisely the substitution this page refuses to make anywhere else. The cost
is that a returning reader who had entered a position fetches the 188 KB
atlas on arrival; a reader who never entered one still fetches nothing.

**The position and the reference pressure were remembered from the start and
gated later, which is its own small lesson.** They are part of the state
object, so they worked the day the memory did — and nothing asserted them, so
a later change could have dropped either silently. Reported as missing.
An ungated feature is one that eventually becomes missing, and the gate now
names every field rather than counting them, and checks that the latitude
reaches the gravity row and the reference pressure reaches the
potential-temperature row rather than merely sitting in its box.

**Reset forgets as a consequence rather than as a second step.** `remember`
stores nothing when the state *is* the defaults, so Reset clearing the memory
falls out of what it already does. Two code paths saying the same thing would
eventually disagree, and the map's saved view has a note about exactly this
failure — reset, then reload, and everything comes back.

**One definition of a valid state, shared with the link codec.** Both a link
and a stored state have been outside this page's control — one through a chat
client, the other written by an older version of this file — so both go
through `sanitise`, which drops what it cannot read rather than refusing the
whole thing. That closed a real hole: kinds used to be taken verbatim, so
`#salinityKind=nonsense` fell through the engine's switch and produced
Standard Seawater with no Practical Salinity at all. Plausible-looking, and
wrong.

**The restore notice is held until the reader touches something**, and that
is a measurement rather than a preference. Four seconds suits "Copied",
because the reader is looking at the button they just pressed. Measured in a
browser, a returning reader had not looked at the page for **29 seconds** —
so the transient version took away the only sentence explaining why the
numbers were not the defaults, 25 seconds before it was read.

**`test:seawater` had to grow a second page load for this**, since the whole
point is what happens on the *next* visit: `reopen()` builds a fresh document
with the storage already in it and imports the bundle again behind a query
string, because `import` of the same specifier returns the same instance and
would re-run nothing. jsdom scopes `localStorage` per instance rather than per
origin, so "the same browser" is copied across by hand — the one simulated
part, which is why the *writing* half is checked against the live store
instead.

**Node has no `localStorage` without `--localstorage-file`, and the page
wraps every storage call in a try/catch** so private browsing still gets a
working calculator. Leave it out of the harness realm and every call throws
ReferenceError, every catch swallows it, and every check passes against a
feature that never ran. It is in the list with a comment saying so.

## Fifty-one properties, and no way to find one

Four requests in a row — the density label, conductivity, the remembered
position, spiciness — were all **"add X" for an X already on the page**. Three
were answered by relabeling the one row involved, which is right each time
and does not converge: the next thing nobody can find is a different row.

The general answer is a filter over the results, and it is the point at which
a list stops being scannable rather than a fault in any one label.

**It searches the note as well as the label**, which is what makes it answer a
question rather than perform a lookup: "compress" is in no label, only in the
notes of the two compressibilities and of in-situ density. Terms are ANDed, so
"spice 2000" reaches one row.

**A filtered-away row is still in the clipboard and the CSV.** Hiding is a
view decision; an export that silently shortened with it would be a data bug
wearing a UI feature's clothes — a reader would get a file missing exactly the
rows they had filtered away, with nothing to say so. `test:seawater` checks it
through the page's own copy path, which jsdom reaches because there is no
`navigator.clipboard` there and the fallback puts the text in a real field.
Reading the module's row list instead would have proved nothing about what
leaves the page.

**`[hidden]` needed its own rule again.** `.results dl > div` scoped by Astro
is three compound selectors against the UA's one, so a filtered row would have
stayed on screen. That is the same trap the map's chrome has a note about, and
jsdom cannot see it — `row.hidden` reads true either way — so it is decided
over the built stylesheet.

The group is called **"Density and spiciness"** now, for the reader who scans
seven headings rather than typing.

## Conductivity was already an input, and nobody could find it

Reported as missing. It had been there from the first build, gated by a
check that a conductivity resolves back to the salinity it came from — in a
menu labeled **Salinity**.

That is the same failure as the density label above, in a control rather than
a readout: the label named one of the two things the field takes, so a reader
holding a conductivity had no reason to open the menu. It is
`Salinity or conductivity` now, and the options are in `<optgroup>`s so the
menu says which are which when it opens.

**The value boxes carry no visible label of their own** — the label belongs to
the menu beside them — so their accessible name is the only thing telling a
screen reader what the number is, and it now follows the selected kind.
Written once as "Salinity value" it said the wrong thing the moment anyone
picked conductivity: the label-written-once trap, in the one place a sighted
reader cannot see it.

**The T–S diagram is contoured, not fitted.** `contour.ts` is marching
squares — there was one in this repository before, deleted when the sea-ice
edge it served was removed; this is not it brought back, since it traces many
levels over a small grid rather than one level over a large one, and runs in
the browser. Every stroke is a class and never an attribute, the same rule the
map's vectors keep and for the same reason: a theme switch has to restyle the
picture with no redraw.

**The contour cache is worth having and is smaller than it looks.** Measured
in a browser: a keystroke that leaves the window alone repaints in **0.98 ms**
and one that moves it takes **3.59 ms**. The first version of that comment
claimed ~8,000 wasted density evaluations; it is 5,120, and the library does
them in about half a millisecond.

**Its check does not measure that saving, and cannot.** In jsdom the DOM work
swamps it — 53 ms a repaint either way — so a timing check there would compare
noise, and the traced paths are deterministic so comparing the output cannot
tell a cache hit from a re-trace. What `test:seawater` checks instead is the
risk the cache actually carries: that leaving the window **redraws** rather
than going stale. Mutation-tested against a cache that never invalidates.

**Mutation-testing it turned up a mutation runner that could not fail.** The
loop piped the harness through `grep FAIL | sed`, so the pipeline's exit
status was `sed`'s and always zero — and `timeout` does not exist on macOS, so
three mutations reported "no failures" while the harness had never run at all.
The same shape as every check-that-cannot-fail in the list below, one level
up: **confirm the mutation reached what you think it did.**
