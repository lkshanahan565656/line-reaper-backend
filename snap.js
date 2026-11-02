// Summarise a .heapsnapshot: self size by node type, and objects grouped by
// constructor + property names (a data shape), with the strings they own.
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const m = s.snapshot.meta, nf = m.node_fields, ef = m.edge_fields;
const NF = nf.length, EF = ef.length;
const nTypes = m.node_types[0], eTypes = m.edge_types[0];
const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iSize = nf.indexOf('self_size'), iEdges = nf.indexOf('edge_count');
const eType = ef.indexOf('type'), eName = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const { nodes, edges, strings } = s;
const MB = b => (b / 1048576).toFixed(1);
const byType = new Map(), shapes = new Map();
let e = 0, total = 0;
const STR = new Set(['string', 'concatenated string', 'sliced string']);
for (let n = 0; n < nodes.length; n += NF) {
  const type = nTypes[nodes[n + iType]], size = nodes[n + iSize], ec = nodes[n + iEdges];
  total += size;
  byType.set(type, (byType.get(type) || 0) + size);
  if (type === 'object') {
    const name = strings[nodes[n + iName]];
    const keys = []; let owned = 0;
    for (let i = 0; i < ec; i++) {
      const k = e + i * EF;
      if (eTypes[edges[k + eType]] !== 'property') continue;
      const key = strings[edges[k + eName]];
      if (keys.length < 7 && !key.startsWith('__')) keys.push(key);
      const to = edges[k + eTo];
      if (STR.has(nTypes[nodes[to + iType]])) owned += nodes[to + iSize];
    }
    const sig = `${name} {${keys.join(',')}}`;
    const x = shapes.get(sig) || { n: 0, self: 0, str: 0 };
    x.n++; x.self += size; x.str += owned;
    shapes.set(sig, x);
  }
  e += ec * EF;
}
console.log('total self', MB(total), 'MB');
for (const [t, b] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`type ${t}: ${MB(b)} MB`);
console.log('--- object shapes by self + owned strings ---');
for (const [sig, x] of [...shapes].sort((a, b) => (b[1].self + b[1].str) - (a[1].self + a[1].str)).slice(0, 45))
  console.log(`${MB(x.self + x.str).padStart(7)} MB  n=${String(x.n).padStart(8)}  self ${MB(x.self)} str ${MB(x.str)}  ${sig.slice(0, 150)}`);
