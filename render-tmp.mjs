import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { plot } from '/Users/gong/GitHub/gliders/packages/plot/plot.ts';
import { parseJsonlCsv } from '/Users/gong/GitHub/gliders/packages/erddap/parse.ts';

const NAMES = ['time','latitude','longitude','depth','pressure','temperature','salinity','conductivity'];
const dom = new JSDOM('<!doctype html><body>');
const doc = dom.window.document;
const NS = 'http://www.w3.org/2000/svg';

const CSS = `.axis{fill:none;stroke:#c8c8c0;stroke-width:1}.trace{fill:none;stroke:#0a5c8c;stroke-width:1.5}.tick{fill:#555b66;font:11px monospace}.axis-name{fill:#16181d;font:12px monospace}.color-frame{fill:none;stroke:#c8c8c0}`;

for (const [tag, file] of [['5m','/tmp/e5.jsonl'], ['1m','/tmp/e1.jsonl']]) {
  const { columns, rows } = parseJsonlCsv(fs.readFileSync(file,'utf8'), { names: NAMES, timeColumns: new Set(['time']) });
  const svg = doc.createElementNS(NS,'svg');
  doc.body.append(svg);
  const t0 = Date.now();
  const r = plot(svg, { x: columns.get('time'), y: columns.get('depth'), c: columns.get('temperature'), n: rows },
    { width: 1500, height: 420, flipY: true, style: 'dots', dot: 2.2, steps: 24, map: 'cmo.thermal',
      cLabel: 'Temperature (°C)', xLabel: `Time — ${tag} depth bin, ${rows.toLocaleString()} samples`, yLabel: 'Depth (m)',
      xTime: true, doc });
  svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
  const st = doc.createElementNS(NS,'style'); st.textContent = CSS; svg.insertBefore(st, svg.firstChild);
  const bg = doc.createElementNS(NS,'rect'); bg.setAttribute('width','1500'); bg.setAttribute('height','420'); bg.setAttribute('fill','#fbfbf9');
  svg.insertBefore(bg, svg.children[1]);
  fs.writeFileSync(`/private/tmp/claude-501/-Users-gong-GitHub-gliders/ab265c81-6bd4-4a66-890f-d8e93ec1b185/scratchpad/sec-${tag}.svg`, new dom.window.XMLSerializer().serializeToString(svg));
  console.log(`${tag}: ${rows.toLocaleString()} rows, drawn ${r.drawn.toLocaleString()}, stride ${r.stride}, ${Date.now()-t0}ms`);
}
