/** Site-wide constants. Nav hrefs are base-relative — `withBase` in
    `lib/url.ts` is what turns them into links. */

export const SITE = {
  title: 'Gliders',
  fullName: 'Glider data, plotted in your browser',
  description:
    'Maps, sections, profiles and T–S diagrams for any glider deployment on the '
    + 'IOOS Glider DAC — and for raw Slocum files, read on your own machine.',
} as const;

export const NAV = [
  { label: 'Deployments', href: '/' },
  { label: 'Local files', href: '/local/' },
] as const;

/** The ERDDAP this site reads. The client takes a base URL, so another
    server can be named — but only this one is tested against. */
export const DAC = 'https://gliders.ioos.us/erddap' as const;

export const REPO = 'https://github.com/oceansensing/gliders' as const;

export const LAB = {
  name: 'C4PO',
  fullName: 'Collaboratory for Physical Oceanography',
  url: 'https://oceansensing.org/',
  decoder: 'https://oceansensing.org/data/slocum/',
} as const;
