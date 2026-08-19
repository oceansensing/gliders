/**
 * The derived seawater properties, computed from what the DAC publishes.
 *
 * A glider dataset carries in-situ temperature, practical salinity and
 * pressure. Everything an oceanographer actually reads a section in —
 * Conservative Temperature, Absolute Salinity, potential density, spice,
 * sound speed — is derived from those three and a position, and none of it
 * is on the server. So it is computed here, per sample, with `@c4po/teos10`.
 *
 * **Absolute Salinity needs a longitude and a latitude**, and that is the
 * whole point of TEOS-10 rather than an implementation detail: the density
 * of seawater depends on what the salt is made of, which varies by ocean and
 * was measured rather than derived. The correction reaches 0.03 g/kg in the
 * North Pacific — about 0.024 kg/m³ — which is thirty times the precision
 * anyone quotes density to. A glider carries its position on every sample,
 * so there is no excuse for skipping it here.
 *
 * Without the atlas loaded, `saFromSP` returns Reference Salinity instead,
 * and this module says so rather than reporting the wrong number under the
 * right name — the one promise `@c4po/teos10` makes beyond arithmetic, kept
 * on this side of the boundary too.
 *
 * **No unit conversion happens here, and that is only safe because of where
 * the numbers come from.** The DAC publishes pressure in dbar and
 * temperature as ITS-90 °C, which is exactly what TEOS-10 wants. Raw Slocum
 * files do not — conductivity in S/m and pressure in bar, both a factor of
 * ten out and both silent when wrong — and that path goes through
 * `@c4po/slocum`'s own `deriveSeawater`, which handles it. Nothing here
 * should grow a second copy of that conversion.
 */

import {
  ctFromT, density, potentialDensity, ptFromCT, ptFromT, saFromSP, soundSpeed,
  spiciness0, srFromSP, type Anomaly,
} from '@c4po/teos10';

/** What a derived variable is called, and how it should be drawn. */
export interface Derived {
  name: string;
  label: string;
  units: string;
  /** cmocean map that suits the field. */
  colormap: string;
  /** A sentence for the aside, saying what it is. */
  note: string;
}

/**
 * The derived set, in the order the chips appear.
 *
 * Absolute Salinity and Conservative Temperature come first because
 * everything below them is computed *from* them, and a reader who wants to
 * know what a section is drawn in should meet them first.
 */
export const DERIVED: readonly Derived[] = [
  {
    name: 'sa',
    label: 'Absolute Salinity',
    units: 'g/kg',
    colormap: 'cmo.haline',
    note: 'TEOS-10 SA, from practical salinity, pressure and position. The mass '
      + 'fraction of dissolved material — what density actually depends on.',
  },
  {
    name: 'ct',
    label: 'Conservative Temperature',
    units: '°C',
    colormap: 'cmo.thermal',
    note: 'TEOS-10 Θ, proportional to potential enthalpy. Conserved under mixing, '
      + 'which in-situ and potential temperature are not.',
  },
  {
    name: 'pt',
    label: 'Potential temperature',
    units: '°C',
    colormap: 'cmo.thermal',
    note: 'θ referenced to the surface — the temperature a parcel would have if '
      + 'raised adiabatically to 0 dbar.',
  },
  {
    name: 'rho',
    label: 'In-situ density',
    units: 'kg/m³',
    colormap: 'cmo.dense',
    note: 'ρ at the sample’s own pressure.',
  },
  {
    name: 'sigma0',
    label: 'Potential density anomaly σ₀',
    units: 'kg/m³',
    colormap: 'cmo.dense',
    note: 'Density referenced to the surface, less 1000. The field water masses '
      + 'are sorted by.',
  },
  {
    name: 'spice0',
    label: 'Spiciness π₀',
    units: 'kg/m³',
    colormap: 'cmo.balance',
    note: 'Orthogonal to σ₀: it varies along an isopycnal, so it separates water '
      + 'masses that weigh the same.',
  },
  {
    name: 'soundSpeed',
    label: 'Sound speed',
    units: 'm/s',
    colormap: 'cmo.speed',
    note: 'The TEOS-10 speed of sound, from the Gibbs function rather than an '
      + 'empirical fit.',
  },
] as const;

export const DERIVED_NAMES: ReadonlySet<string> = new Set(DERIVED.map((d) => d.name));

/** The columns a derivation needs from the dataset. */
export interface Inputs {
  /** Practical salinity. */
  sp: Float64Array;
  /** In-situ temperature, ITS-90 °C. */
  t: Float64Array;
  /** Sea pressure, dbar. */
  p: Float64Array;
  lon?: Float64Array;
  lat?: Float64Array;
}

export interface DeriveResult {
  columns: Map<string, Float64Array>;
  /** True when SA is really Reference Salinity, because no atlas or no
      position was available. The page has to say so. */
  referenceOnly: boolean;
  /** Samples that produced a finite value, per column. */
  counts: Map<string, number>;
}

/**
 * Compute the requested properties.
 *
 * `wanted` is filtered to the derived set; anything else is ignored rather
 * than throwing, because the caller is a UI passing along a reader's chips.
 *
 * The dependency order is fixed and not negotiable — SA before CT, CT before
 * spice — so the whole chain is evaluated per sample in one pass whatever
 * was asked for. Computing only the requested leaf and re-deriving its
 * inputs on the next request would evaluate the Gibbs function two and three
 * times over for the same sample.
 */
export function derive(
  inputs: Inputs,
  wanted: readonly string[],
  atlas?: Anomaly | null,
): DeriveResult {
  const want = new Set(wanted.filter((w) => DERIVED_NAMES.has(w)));
  const n = inputs.sp.length;
  const out = new Map<string, Float64Array>();
  const counts = new Map<string, number>();
  for (const name of want) {
    out.set(name, new Float64Array(n).fill(NaN));
    counts.set(name, 0);
  }

  const hasPosition = Boolean(inputs.lon && inputs.lat && atlas);
  const referenceOnly = want.size > 0 && !hasPosition;

  const { sp, t, p, lon, lat } = inputs;
  const col = (name: string): Float64Array | undefined => out.get(name);
  const saOut = col('sa');
  const ctOut = col('ct');
  const ptOut = col('pt');
  const rhoOut = col('rho');
  const sig0Out = col('sigma0');
  const spiceOut = col('spice0');
  const cOut = col('soundSpeed');

  /* Whether the chain has to run at all for this sample: every property
     below needs SA, so a missing salinity, temperature or pressure means
     there is nothing to compute and the NaN already in place is correct. */
  const needsCt = Boolean(ctOut || spiceOut);

  for (let i = 0; i < n; i++) {
    const spi = sp[i];
    const ti = t[i];
    const pi = p[i];
    if (!(spi === spi && ti === ti && pi === pi)) continue;

    /* Reference Salinity where there is no atlas or no position — the same
       fallback `@c4po/teos10` makes, surfaced rather than hidden. */
    const sa = hasPosition
      ? saFromSP(spi, pi, lon![i], lat![i], atlas)
      : srFromSP(spi);
    if (!(sa === sa)) continue;

    if (saOut) { saOut[i] = sa; counts.set('sa', counts.get('sa')! + 1); }

    let ct = NaN;
    if (needsCt) ct = ctFromT(sa, ti, pi);
    if (ctOut && ct === ct) { ctOut[i] = ct; counts.set('ct', counts.get('ct')! + 1); }

    if (ptOut) {
      const v = ptFromT(sa, ti, pi, 0);
      if (v === v) { ptOut[i] = v; counts.set('pt', counts.get('pt')! + 1); }
    }
    if (rhoOut) {
      const v = density(sa, ti, pi);
      if (v === v) { rhoOut[i] = v; counts.set('rho', counts.get('rho')! + 1); }
    }
    if (sig0Out) {
      const v = potentialDensity(sa, ti, pi, 0) - 1000;
      if (v === v) { sig0Out[i] = v; counts.set('sigma0', counts.get('sigma0')! + 1); }
    }
    if (spiceOut && ct === ct) {
      const v = spiciness0(sa, ct);
      if (v === v) { spiceOut[i] = v; counts.set('spice0', counts.get('spice0')! + 1); }
    }
    if (cOut) {
      const v = soundSpeed(sa, ti, pi);
      if (v === v) { cOut[i] = v; counts.set('soundSpeed', counts.get('soundSpeed')! + 1); }
    }
  }

  return { columns: out, referenceOnly, counts };
}

/** σ₀ over a T–S window, for the diagram's isopycnals. `v[j][i]` is the
    value at (SA_i, CT_j) — the grid shape `@c4po/teos10`'s `contour` wants.
    Computed at the surface, which is what makes them σ₀ rather than lines
    that depend on which sample's pressure was picked. */
export function sigmaField(
  saLo: number, saHi: number, ctLo: number, ctHi: number, steps = 48,
): { v: number[][]; x0: number; dx: number; y0: number; dy: number } {
  const dx = (saHi - saLo) / (steps - 1);
  const dy = (ctHi - ctLo) / (steps - 1);
  const v: number[][] = [];
  for (let j = 0; j < steps; j++) {
    const ct = ctLo + j * dy;
    const row: number[] = [];
    for (let i = 0; i < steps; i++) {
      const sa = saLo + i * dx;
      /* `potentialDensity` takes *in-situ* temperature. At a surface
         reference the in-situ temperature is the potential temperature, and
         `ptFromCT` is the exact conversion from the axis's Conservative
         Temperature to it — so the grid is σ₀ of the point the reader is
         actually looking at, rather than of a parcel at some other depth. */
      row.push(potentialDensity(sa, ptFromCT(sa, ct), 0, 0) - 1000);
    }
    v.push(row);
  }
  return { v, x0: saLo, dx, y0: ctLo, dy };
}
