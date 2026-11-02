// Summarise a .heapsnapshot: self size by node type, and objects grouped by
// constructor + property names (a data shape), with the strings they own.
const fs = require('fs');
// the file is bigger than a JS string can be: read it as bytes
const buf = fs.readFileSync(process.argv[2]);
const find = (str, from = 0) => { const i = buf.indexOf(str, from); if (i < 0) throw new Error(`no ${str}`); return i; };
const nodesAt = find('"nodes":[');
const head = buf.subarray(0, nodesAt).toString('utf8').replace(/,\s*$/, '') + '}';
const s = JSON.parse(head);
function ints(start, count) {
  const out = new Float64Array(count); let i = start, n = 0, v = 0, inNum = false;
  for (; n < count; i++) {
    const c = buf[i];
    if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); inNum = true; }
    else if (inNum) { out[n++] = v; v = 0; inNum = false; }
  }
  return { arr: out, end: i };
}
const NFc = s.snapshot.meta.node_fields.length, EFc = s.snapshot.meta.edge_fields.length;
const nn = ints(nodesAt + 9, s.snapshot.node_count * NFc);
const edgesAt = find('"edges":[', nn.end);
const ee = ints(edgesAt + 9, s.snapshot.edge_count * EFc);
s.nodes = nn.arr; s.edges = ee.arr;
let i = find('"strings":[', ee.end) + 11;
s.strings = [];
while (true) {
  while (buf[i] !== 34 && buf[i] !== 93) i++;
  if (buf[i] === 93) break;
  let j = i + 1;
  while (buf[j] !== 34) j += buf[j] === 92 ? 2 : 1;
  s.strings.push(j - i < 2000000 ? JSON.parse(buf.subarray(i, j + 1).toString('utf8')) : '(long)');
  i = j + 1;
}
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
      const et = eTypes[edges[k + eType]];
      if (et === 'internal') {
        const nm = strings[edges[k + eName]];
        if (nm === 'elements' || nm === 'table' || nm === 'properties') owned += nodes[edges[k + eTo] + iSize];
        continue;
      }
      if (et !== 'property') continue;
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
