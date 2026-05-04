import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import Papa from 'papaparse';

const FILE = 'All Committees Merged.csv';
const FADE_TAU = 8;
const FADE_FLOOR = 0.05;
const FADE_BASE = 0.45;
const MIN_YEAR = 1987;
const MAX_YEAR = 2026;
const COUNCILS = new Set(['senate administration council', 'senate council']);

function isCouncil(name) {
  return COUNCILS.has((name || '').trim().toLowerCase());
}

function extractYear(s) {
  if (s == null) return null;
  const m = String(s).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

function hashColor(str) {
  if (!str) str = 'Unknown';
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const sat = 55 + (Math.abs(h >> 8) % 25);
  const lig = 48 + (Math.abs(h >> 16) % 14);
  return `hsl(${hue}, ${sat}%, ${lig}%)`;
}

function buildIndex(rows) {
  const persons = new Map();
  const yearCommittees = new Map();
  const allYears = new Set();
  const deptCounts = new Map();

  for (const row of rows) {
    const year = extractYear(row.Year);
    if (!year || year < MIN_YEAR || year > MAX_YEAR) continue;
    const first = (row['First Name'] || '').trim();
    const last = (row['Last Name'] || '').trim();
    if (!first && !last) continue;
    const id = (first + '__' + last).toLowerCase();
    const committee = (row.Committee || '').trim();
    if (!committee) continue;
    const dept = ((row.Department || '').trim()) || 'Unknown';

    if (!persons.has(id)) {
      persons.set(id, {
        id, first, last,
        name: (first + ' ' + last).replace(/\s+/g, ' ').trim(),
        deptCounts: new Map(),
        byYear: new Map(),
        years: new Set(),
        firstYear: year, lastYear: year
      });
    }
    const p = persons.get(id);
    p.deptCounts.set(dept, (p.deptCounts.get(dept) || 0) + 1);
    p.years.add(year);
    if (year < p.firstYear) p.firstYear = year;
    if (year > p.lastYear) p.lastYear = year;
    if (!p.byYear.has(year)) p.byYear.set(year, new Map());
    p.byYear.get(year).set(committee, row.Capacity || '');

    if (!yearCommittees.has(year)) yearCommittees.set(year, new Map());
    const yc = yearCommittees.get(year);
    if (!yc.has(committee)) yc.set(committee, new Set());
    yc.get(committee).add(id);

    deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
    allYears.add(year);
  }

  for (const p of persons.values()) {
    let max = 0, primary = 'Unknown';
    for (const [d, c] of p.deptCounts) if (c > max) { max = c; primary = d; }
    p.dept = primary;
    p.color = hashColor(primary);
  }

  return {
    persons, yearCommittees,
    years: [...allYears].sort((a, b) => a - b),
    deptCounts
  };
}

function computeNetwork(year, idx, cache, excludeCouncils) {
  const cacheKey = year + (excludeCouncils ? '|noc' : '');
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const { persons, yearCommittees, years } = idx;
  const active = new Set();
  const yMap = yearCommittees.get(year);
  if (yMap) {
    for (const [committee, members] of yMap) {
      if (excludeCouncils && isCouncil(committee)) continue;
      for (const m of members) active.add(m);
    }
  }

  const edges = new Map();

  if (yMap) {
    for (const [committee, members] of yMap) {
      if (excludeCouncils && isCouncil(committee)) continue;
      const arr = [...members];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          const key = a < b ? a + '|' + b : b + '|' + a;
          if (!edges.has(key)) {
            edges.set(key, {
              source: a < b ? a : b, target: a < b ? b : a,
              currentCommittees: [], pastEvents: []
            });
          }
          edges.get(key).currentCommittees.push(committee);
        }
      }
    }
  }

  for (const py of years) {
    if (py >= year) break;
    const pyMap = yearCommittees.get(py);
    if (!pyMap) continue;
    for (const [committee, members] of pyMap) {
      if (excludeCouncils && isCouncil(committee)) continue;
      const arr = [];
      for (const m of members) if (active.has(m)) arr.push(m);
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          const key = a < b ? a + '|' + b : b + '|' + a;
          if (!edges.has(key)) {
            edges.set(key, {
              source: a < b ? a : b, target: a < b ? b : a,
              currentCommittees: [], pastEvents: []
            });
          }
          edges.get(key).pastEvents.push({ year: py, committee });
        }
      }
    }
  }

  const edgeList = [];
  for (const e of edges.values()) {
    let type;
    if (e.currentCommittees.length > 0 && e.pastEvents.length > 0) type = 'repeated';
    else if (e.currentCommittees.length > 0) type = 'current';
    else type = 'former';
    let lastPast = null;
    if (e.pastEvents.length > 0) {
      lastPast = e.pastEvents[0].year;
      for (const p of e.pastEvents) if (p.year > lastPast) lastPast = p.year;
    }
    edgeList.push({
      source: e.source, target: e.target, type,
      currentCommittees: e.currentCommittees, pastEvents: e.pastEvents,
      lastPast, yearsSince: lastPast != null ? year - lastPast : null,
      pastCount: e.pastEvents.length, currentCount: e.currentCommittees.length
    });
  }

  const result = {
    nodes: [...active].map(id => persons.get(id)),
    edges: edgeList
  };
  cache.set(cacheKey, result);
  return result;
}

function formatYear(y) {
  return y + '\u2013' + String((y + 1) % 100).padStart(2, '0');
}

function escapeHtml(s) {
  if (s == null) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

function edgeStyle(e, palette) {
  if (e.type === 'current') {
    return { stroke: palette.current, width: 1.5, opacity: 0.6, dash: null };
  }
  if (e.type === 'repeated') {
    const op = Math.min(0.95, 0.7 + 0.04 * e.pastCount);
    const w = Math.min(5, 2 + 0.4 * e.pastCount);
    return { stroke: palette.repeated, width: w, opacity: op, dash: null };
  }
  const op = Math.max(FADE_FLOOR, FADE_BASE * Math.exp(-(e.yearsSince || 0) / FADE_TAU));
  return { stroke: palette.former, width: 0.8, opacity: op, dash: '3 2' };
}

export default function CommitteeNetwork() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsFile, setNeedsFile] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Initializing...');
  const [idx, setIdx] = useState(null);
  const [yearIdx, setYearIdx] = useState(0);
  const [edgeFilter, setEdgeFilter] = useState({ current: true, repeated: true, former: true });
  const [showNodeLabels, setShowNodeLabels] = useState(true);
  const [showCommitteeLabels, setShowCommitteeLabels] = useState(false);
  const [excludeCouncils, setExcludeCouncils] = useState(false);
  const [spread, setSpread] = useState(1.0);
  const [searchTerm, setSearchTerm] = useState('');
  const [info, setInfo] = useState({ nodes: 0, edges: 0, deptCounts: new Map() });
  const [tooltip, setTooltip] = useState({ visible: false, x: 0, y: 0, html: '' });
  const [darkMode, setDarkMode] = useState(false);
  const [selected, setSelected] = useState(null);
  const [egoOnly, setEgoOnly] = useState(false);
  const [neighborCount, setNeighborCount] = useState(0);

  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const nodePositionsRef = useRef(new Map());
  const networkCacheRef = useRef(new Map());
  const simulationRef = useRef(null);
  const selectedRef = useRef(null);
  const egoOnlyRef = useRef(false);
  const zoomRef = useRef(null);
  const rootGroupRef = useRef(null);
  const searchTermRef = useRef('');
  const paletteRef = useRef(null);
  const idxRef = useRef(null);
  const yearRef = useRef(null);
  const spreadRef = useRef(1.0);
  const excludeCouncilsRef = useRef(false);
  const showCommitteeLabelsRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setDarkMode(mq.matches);
    const handler = e => setDarkMode(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const palette = darkMode
    ? { bg: '#181816', surface: '#232320', border: 'rgba(255,255,255,0.14)',
        text: '#e8e8e3', textMuted: '#a0a09a', textFaint: '#707068',
        accent: '#5dcaa5', selected: '#ffd166',
        current: '#c0c0b8', repeated: '#f0f0e8',
        former: '#888880', highlight: '#f09595',
        committeeLabel: 'rgba(232,232,227,0.18)' }
    : { bg: '#fafaf7', surface: '#ffffff', border: 'rgba(0,0,0,0.12)',
        text: '#1a1a1a', textMuted: '#5a5a5a', textFaint: '#8a8a8a',
        accent: '#1d9e75', selected: '#cc7a00',
        current: '#444444', repeated: '#1a1a1a',
        former: '#888888', highlight: '#e24b4a',
        committeeLabel: 'rgba(26,26,26,0.16)' };

  useEffect(() => { paletteRef.current = palette; }, [palette]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { yearRef.current = idx ? idx.years[yearIdx] : null; }, [idx, yearIdx]);
  useEffect(() => { searchTermRef.current = searchTerm; }, [searchTerm]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { egoOnlyRef.current = egoOnly; }, [egoOnly]);
  useEffect(() => { spreadRef.current = spread; }, [spread]);
  useEffect(() => { excludeCouncilsRef.current = excludeCouncils; }, [excludeCouncils]);
  useEffect(() => { showCommitteeLabelsRef.current = showCommitteeLabels; }, [showCommitteeLabels]);

  async function processCSVText(text) {
    setStatusMsg('Parsing CSV...');
    const parsed = Papa.parse(text, {
      header: true, skipEmptyLines: true,
      transformHeader: h => h.trim()
    });
    setStatusMsg('Indexing ' + parsed.data.length.toLocaleString() + ' rows...');
    await new Promise(r => setTimeout(r, 0));
    const built = buildIndex(parsed.data);
    if (built.years.length === 0) {
      throw new Error('No valid years (' + MIN_YEAR + '\u2013' + MAX_YEAR + ') found in CSV');
    }
    nodePositionsRef.current = new Map();
    networkCacheRef.current = new Map();
    selectedRef.current = null;
    setSelected(null);
    setEgoOnly(false);
    setIdx(built);
    setYearIdx(built.years.length - 1);
    setStatusMsg(
      built.persons.size.toLocaleString() + ' persons \u00b7 ' +
      built.years.length + ' years (' + built.years[0] + '\u2013' +
      built.years[built.years.length - 1] + ') \u00b7 ' +
      built.deptCounts.size + ' departments'
    );
    setNeedsFile(false);
    setError(null);
    setLoading(false);
  }

  async function handleFileInput(file) {
    if (!file) return;
    setError(null);
    setLoading(true);
    setNeedsFile(false);
    try {
      setStatusMsg('Reading ' + file.name + '...');
      const text = await file.text();
      await processCSVText(text);
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
      setLoading(false);
    }
  }

useEffect(() => {
  let cancelled = false;
  (async () => {
    try {
      setStatusMsg('Loading data...');
      const csvUrl = `${import.meta.env.BASE_URL}data.csv`;
      const response = await fetch(csvUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (cancelled) return;
      await processCSVText(text);
    } catch (err) {
      console.error(err);
      if (!cancelled) {
        // Fall back to file-picker if fetch fails
        setNeedsFile(true);
        setLoading(false);
        setStatusMsg('Could not load bundled data');
        setError(err.message || String(err));
      }
    }
  })();
  return () => { cancelled = true; };
}, []);

  function applyVisualState() {
    const root = rootGroupRef.current;
    const pal = paletteRef.current;
    if (!root || !pal) return;
    const sel = selectedRef.current;
    const ego = egoOnlyRef.current;
    const term = (searchTermRef.current || '').toLowerCase();

    const neighbors = new Set();
    if (sel) {
      neighbors.add(sel.id);
      root.selectAll('g.edges line').each(function(e) {
        if (e.source.id === sel.id) neighbors.add(e.target.id);
        if (e.target.id === sel.id) neighbors.add(e.source.id);
      });
    }

    const dim = ego ? 0 : 0.18;
    const edgeDim = ego ? 0 : 0.12;

    root.selectAll('g.nodes circle').attr('opacity', n => {
      if (!sel) return 1;
      return neighbors.has(n.id) ? 1 : dim;
    });
    root.selectAll('g.labels text').attr('opacity', n => {
      if (!sel) return 1;
      return neighbors.has(n.id) ? 1 : dim;
    });
    root.selectAll('g.edges line').attr('stroke-opacity', e => {
      const baseOp = e.__style ? e.__style.opacity : 0.5;
      if (!sel) return baseOp;
      if (e.source.id === sel.id || e.target.id === sel.id) return Math.max(0.7, baseOp);
      return baseOp * edgeDim;
    });

    root.selectAll('g.nodes circle')
      .attr('stroke', n => {
        if (sel && n.id === sel.id) return pal.selected;
        if (term && (n.last.toLowerCase().includes(term) || n.first.toLowerCase().includes(term))) return pal.highlight;
        return pal.bg;
      })
      .attr('stroke-width', n => {
        if (sel && n.id === sel.id) return 3.2;
        if (term && (n.last.toLowerCase().includes(term) || n.first.toLowerCase().includes(term))) return 2.4;
        return 1.2;
      });

    // Committee labels: filter to ego's committees if ego mode is on
    const yr = yearRef.current;
    let egoCommittees = null;
    if (sel && ego && yr != null) {
      const m = sel.byYear.get(yr);
      if (m) egoCommittees = new Set(m.keys());
    }
    root.selectAll('g.committee-labels text').attr('display', d => {
      if (!showCommitteeLabelsRef.current) return 'none';
      if (egoCommittees && !egoCommittees.has(d.committee)) return 'none';
      return null;
    });

    if (sel) {
      let count = 0;
      root.selectAll('g.edges line').each(function(e) {
        if (e.source.id === sel.id || e.target.id === sel.id) count++;
      });
      setNeighborCount(count);
    } else {
      setNeighborCount(0);
    }
  }

  function handleNodeSelection(node) {
    const cur = selectedRef.current;
    if (cur && cur.id === node.id) {
      selectedRef.current = null;
      setSelected(null);
      setEgoOnly(false);
      egoOnlyRef.current = false;
    } else {
      selectedRef.current = node;
      setSelected(node);
    }
    applyVisualState();
  }

  function buildHistoryHtml(d, year, pal) {
    const ex = excludeCouncilsRef.current;
    const yrs = [...d.byYear.keys()].filter(y => y <= year).sort();
    const items = [];
    for (const y of yrs) {
      const m = d.byYear.get(y);
      const cmts = [...m.keys()].filter(c => !(ex && isCouncil(c)));
      if (cmts.length === 0) continue;
      items.push(
        '<li><span style="color:' + pal.text + '">' + formatYear(y) + '</span> \u2014 ' +
        cmts.map(c => escapeHtml(c)).join('; ') + '</li>'
      );
    }
    if (items.length === 0) return '';
    return '<div style="margin-top:8px;color:' + pal.textMuted + ';font-size:10px">Full history through ' + formatYear(year) + ':</div>' +
      '<ul style="margin:4px 0 0;padding-left:14px;color:' + pal.textMuted + ';font-size:10px;line-height:1.45">' +
      items.join('') + '</ul>';
  }

  function showNodeTooltip(ev, d, year) {
    const pal = paletteRef.current;
    const yMap = d.byYear.get(year) || new Map();
    const ex = excludeCouncilsRef.current;
    const cmts = [...yMap.keys()].filter(c => !(ex && isCouncil(c)));
    let html = '<div style="font-weight:500">' + escapeHtml(d.name) + '</div>' +
      '<div style="color:' + pal.textMuted + ';font-size:10px;margin:2px 0 6px">' + escapeHtml(d.dept) + '</div>' +
      '<div style="color:' + pal.textMuted + '">In ' + formatYear(year) + ':</div>' +
      '<ul style="margin:4px 0 0;padding-left:14px;color:' + pal.textMuted + '">' +
      (cmts.length === 0
        ? '<li style="color:' + pal.textFaint + ';font-style:italic">(none in non-excluded committees)</li>'
        : cmts.map(c => {
            const cap = yMap.get(c);
            return '<li>' + escapeHtml(c) + (cap ? ' <span style="color:' + pal.textFaint + '">\u00b7 ' + escapeHtml(cap) + '</span>' : '') + '</li>';
          }).join('')) +
      '</ul>' +
      buildHistoryHtml(d, year, pal) +
      '<div style="margin-top:6px;color:' + pal.textFaint + ';font-size:10px">Active ' + d.firstYear + '\u2013' + d.lastYear + ' \u00b7 ' + d.years.size + ' year(s) \u00b7 click to pin</div>';
    showTooltip(ev, html);
  }

  function showEdgeTooltip(ev, d) {
    const pal = paletteRef.current;
    const a = d.source.name || d.source;
    const b = d.target.name || d.target;
    let html = '<div><span style="font-weight:500">' + escapeHtml(a) + '</span> \u2194 <span style="font-weight:500">' + escapeHtml(b) + '</span></div>';
    html += '<div style="color:' + pal.textMuted + ';font-size:10px;margin:2px 0 6px">' + d.type + ' tie</div>';
    if (d.currentCommittees.length) {
      html += '<div style="color:' + pal.textMuted + '">Currently shared:</div><ul style="margin:4px 0 0;padding-left:14px;color:' + pal.textMuted + '">' +
        d.currentCommittees.map(c => '<li>' + escapeHtml(c) + '</li>').join('') + '</ul>';
    }
    if (d.pastEvents.length) {
      const byCommittee = new Map();
      for (const e of d.pastEvents) {
        if (!byCommittee.has(e.committee)) byCommittee.set(e.committee, []);
        byCommittee.get(e.committee).push(e.year);
      }
      html += '<div style="color:' + pal.textMuted + ';margin-top:4px">Previously shared:</div><ul style="margin:4px 0 0;padding-left:14px;color:' + pal.textMuted + '">';
      for (const [c, ys] of byCommittee) {
        ys.sort();
        html += '<li>' + escapeHtml(c) + ' <span style="color:' + pal.textFaint + '">(' + ys.join(', ') + ')</span></li>';
      }
      html += '</ul>';
    }
    showTooltip(ev, html);
  }

  function showTooltip(ev, html) {
    if (!containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    setTooltip({ visible: true, x, y, html });
  }

  function moveTooltip(ev) {
    if (!containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    setTooltip(t => t.visible ? { ...t, x, y } : t);
  }

  function hideTooltip() { setTooltip(t => ({ ...t, visible: false })); }

  const renderYear = useCallback((year, animated) => {
    const cidx = idxRef.current;
    if (!cidx || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const width = r.width, height = r.height;
    if (width < 10 || height < 10) return;

    if (simulationRef.current) simulationRef.current.stop();

    const exNow = excludeCouncilsRef.current;
    const sp = spreadRef.current;
    const sqSp = Math.sqrt(sp);

    const net = computeNetwork(year, cidx, networkCacheRef.current, exNow);
    const cx = width / 2, cy = height / 2;

    const cachedIds = new Set();
    for (const n of net.nodes) {
      if (nodePositionsRef.current.has(n.id)) cachedIds.add(n.id);
    }

    const placementNeighbors = new Map();
    for (const e of net.edges) {
      if (e.type === 'former') continue;
      const a = e.source, b = e.target;
      if (!cachedIds.has(a) && cachedIds.has(b)) {
        if (!placementNeighbors.has(a)) placementNeighbors.set(a, []);
        placementNeighbors.get(a).push(nodePositionsRef.current.get(b));
      }
      if (!cachedIds.has(b) && cachedIds.has(a)) {
        if (!placementNeighbors.has(b)) placementNeighbors.set(b, []);
        placementNeighbors.get(b).push(nodePositionsRef.current.get(a));
      }
    }

    const nodes = net.nodes.map(orig => {
      const node = Object.assign({}, orig);
      const pos = nodePositionsRef.current.get(node.id);
      if (pos) {
        node.x = pos.x; node.y = pos.y;
      } else {
        const nbrs = placementNeighbors.get(node.id);
        if (nbrs && nbrs.length > 0) {
          let sx = 0, sy = 0;
          for (const p of nbrs) { sx += p.x; sy += p.y; }
          node.x = sx / nbrs.length + (Math.random() - 0.5) * 24;
          node.y = sy / nbrs.length + (Math.random() - 0.5) * 24;
        } else {
          const angle = Math.random() * Math.PI * 2;
          const radius = 60 + Math.random() * 120;
          node.x = cx + Math.cos(angle) * radius;
          node.y = cy + Math.sin(angle) * radius;
        }
      }
      node.vx = 0; node.vy = 0;
      return node;
    });

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const edges = net.edges
      .filter(e => edgeFilter[e.type])
      .map(e => Object.assign({}, e, {
        source: nodeById.get(e.source),
        target: nodeById.get(e.target)
      }));

    for (const n of nodes) {
      let deg = 0;
      for (const e of edges) if (e.source === n || e.target === n) deg++;
      n.degree = deg;
    }

    const yrDeptCounts = new Map();
for (const n of nodes) {
  yrDeptCounts.set(n.dept, (yrDeptCounts.get(n.dept) || 0) + 1);
}
setInfo({ nodes: nodes.length, edges: edges.length, deptCounts: yrDeptCounts });

    // Build committee->members map for current year
    const committeeMembers = new Map();
    for (const n of nodes) {
      const ym = n.byYear.get(year);
      if (!ym) continue;
      for (const c of ym.keys()) {
        if (exNow && isCouncil(c)) continue;
        if (!committeeMembers.has(c)) committeeMembers.set(c, []);
        committeeMembers.get(c).push(n);
      }
    }
    const committeeLabelData = [];
    for (const [c, members] of committeeMembers) {
      if (members.length >= 2) committeeLabelData.push({ committee: c, members });
    }

    const root = rootGroupRef.current;
    if (!root) return;
    const gCmtLabels = root.select('g.committee-labels');
    const gEdges = root.select('g.edges');
    const gNodes = root.select('g.nodes');
    const gLabels = root.select('g.labels');

    const edgeKey = d => {
      const s = typeof d.source === 'string' ? d.source : d.source.id;
      const t = typeof d.target === 'string' ? d.target : d.target.id;
      return s + '|' + t;
    };

    const pal = paletteRef.current;

    // Committee labels
    const cmtSel = gCmtLabels.selectAll('text').data(committeeLabelData, d => d.committee);
    cmtSel.exit().remove();
    const cmtEnter = cmtSel.enter().append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-family', 'Georgia, "Times New Roman", serif')
      .style('font-style', 'italic')
      .style('font-weight', '500')
      .style('pointer-events', 'none')
      .style('user-select', 'none');
    const cmtMerged = cmtEnter.merge(cmtSel);
    cmtMerged
      .attr('fill', pal.committeeLabel)
      .style('font-size', d => Math.min(34, 14 + Math.sqrt(d.members.length) * 3.2) + 'px')
      .text(d => d.committee)
      .attr('display', () => showCommitteeLabelsRef.current ? null : 'none');

    // Edges
    const edgeSel = gEdges.selectAll('line').data(edges, edgeKey);
    edgeSel.exit().remove();
    const edgeEnter = edgeSel.enter().append('line').attr('stroke-linecap', 'round');
    const edgeMerged = edgeEnter.merge(edgeSel);
    edgeMerged.each(function(d) {
      const s = edgeStyle(d, pal);
      d.__style = s;
      d3.select(this)
        .attr('stroke', s.stroke)
        .attr('stroke-width', s.width)
        .attr('stroke-opacity', s.opacity)
        .attr('stroke-dasharray', s.dash)
        .style('cursor', 'pointer');
    });
    edgeMerged
      .on('mouseover', function(ev, d) { showEdgeTooltip(ev, d); })
      .on('mousemove', moveTooltip)
      .on('mouseout', hideTooltip);

    // Nodes
    const nodeSel = gNodes.selectAll('circle').data(nodes, d => d.id);
    nodeSel.exit().remove();

    const dragBeh = d3.drag()
      .on('start', function(ev, d) {
        d.__dragMoved = false;
        if (!ev.active) simulationRef.current.alphaTarget(0.25).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', function(ev, d) {
        const dx = ev.x - d.x, dy = ev.y - d.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) d.__dragMoved = true;
        d.fx = ev.x; d.fy = ev.y;
        nodePositionsRef.current.set(d.id, { x: ev.x, y: ev.y });
      })
      .on('end', function(ev, d) {
        if (!ev.active) simulationRef.current.alphaTarget(0);
        if (d.__dragMoved) {
          nodePositionsRef.current.set(d.id, { x: d.fx, y: d.fy });
          d.fx = null; d.fy = null;
        } else {
          d.fx = null; d.fy = null;
          handleNodeSelection(d);
        }
      });

    const nodeEnter = nodeSel.enter().append('circle')
      .attr('r', d => 4 + Math.sqrt(d.degree || 1) * 0.8)
      .attr('fill', d => d.color)
      .attr('stroke', pal.bg)
      .attr('stroke-width', 1.2)
      .style('cursor', 'pointer')
      .on('mouseover', function(ev, d) { showNodeTooltip(ev, d, year); })
      .on('mousemove', moveTooltip)
      .on('mouseout', function() { hideTooltip(); })
      .call(dragBeh);
    const nodeMerged = nodeEnter.merge(nodeSel);
    nodeMerged
      .attr('r', d => 4 + Math.sqrt(d.degree || 1) * 0.8)
      .attr('fill', d => d.color);

    // Node labels
    const labelData = showNodeLabels ? nodes : [];
    const labelSel = gLabels.selectAll('text').data(labelData, d => d.id);
    labelSel.exit().remove();
    const labelEnter = labelSel.enter().append('text')
      .attr('text-anchor', 'middle')
      .style('font-size', '9px')
      .style('pointer-events', 'none')
      .style('user-select', 'none')
      .style('paint-order', 'stroke')
      .attr('stroke-width', 2.5)
      .attr('stroke-linejoin', 'round');
    const labelMerged = labelEnter.merge(labelSel);
    labelMerged
      .attr('dy', d => -(4 + Math.sqrt(d.degree || 1) * 0.8) - 3)
      .attr('fill', pal.text)
      .attr('stroke', pal.bg)
      .text(d => d.last);

    const targetAlpha = animated ? 0.22 : 0.85;
    const decay = animated ? 0.045 : 0.028;

    simulationRef.current = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges)
        .id(d => d.id)
        .distance(d => {
          let base;
          if (d.type === 'repeated') base = 28;
          else if (d.type === 'current') base = 38;
          else base = 70;
          return base * sqSp;
        })
        .strength(d => {
          if (d.type === 'repeated') return 0.6;
          if (d.type === 'current') return 0.45;
          return 0.04;
        }))
      .force('charge', d3.forceManyBody().strength(-90 * sp).distanceMax(280 * sqSp))
      .force('center', d3.forceCenter(cx, cy).strength(0.04))
      .force('collide', d3.forceCollide().radius(d => (6 + Math.sqrt(d.degree || 1) * 0.8) * sqSp))
      .alpha(targetAlpha)
      .alphaDecay(decay)
      .on('tick', () => {
        for (const n of nodes) {
          if (n.fx == null) nodePositionsRef.current.set(n.id, { x: n.x, y: n.y });
        }
        gEdges.selectAll('line')
          .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        gNodes.selectAll('circle')
          .attr('cx', d => d.x).attr('cy', d => d.y);
        gLabels.selectAll('text')
          .attr('x', d => d.x).attr('y', d => d.y);
        gCmtLabels.selectAll('text')
          .each(function(d) {
            let sx = 0, sy = 0;
            for (const m of d.members) { sx += m.x; sy += m.y; }
            d3.select(this)
              .attr('x', sx / d.members.length)
              .attr('y', sy / d.members.length);
          });
      });

    if (selectedRef.current) {
      const fresh = nodes.find(n => n.id === selectedRef.current.id);
      if (fresh) {
        selectedRef.current = fresh;
        setSelected(fresh);
      } else {
        selectedRef.current = null;
        setSelected(null);
        setEgoOnly(false);
        egoOnlyRef.current = false;
      }
    }
    setTimeout(applyVisualState, 0);
  }, [edgeFilter, showNodeLabels, showCommitteeLabels]);

  // Spread changes update the running simulation in place (no full re-render)
  useEffect(() => {
    const sim = simulationRef.current;
    if (!sim) return;
    const sqSp = Math.sqrt(spread);
    const charge = sim.force('charge');
    if (charge) charge.strength(-90 * spread).distanceMax(280 * sqSp);
    const linkF = sim.force('link');
    if (linkF) {
      linkF.distance(d => {
        const base = d.type === 'repeated' ? 28 : (d.type === 'current' ? 38 : 70);
        return base * sqSp;
      });
    }
    const collide = sim.force('collide');
    if (collide) collide.radius(d => (6 + Math.sqrt(d.degree || 1) * 0.8) * sqSp);
    sim.alpha(0.4).restart();
  }, [spread]);

  useEffect(() => {
    if (!svgRef.current || !idx) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    const root = svg.append('g').attr('class', 'root');
    rootGroupRef.current = root;
    // z-order: committee labels (back), edges, nodes, node labels (front)
    root.append('g').attr('class', 'committee-labels');
    root.append('g').attr('class', 'edges');
    root.append('g').attr('class', 'nodes');
    root.append('g').attr('class', 'labels');

    zoomRef.current = d3.zoom()
      .scaleExtent([0.2, 6])
      .on('zoom', (ev) => root.attr('transform', ev.transform));
    svg.call(zoomRef.current);
    svg.on('click', function(ev) {
      if (ev.target === svgRef.current || ev.target.tagName === 'g') {
        if (selectedRef.current) {
          selectedRef.current = null;
          setSelected(null);
          setEgoOnly(false);
          egoOnlyRef.current = false;
          applyVisualState();
        }
      }
    });

    const onResize = () => {
      if (yearRef.current != null) renderYear(yearRef.current, false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [idx]);

  useEffect(() => {
    if (!idx) return;
    renderYear(idx.years[yearIdx], true);
  }, [idx, yearIdx, edgeFilter, showNodeLabels, showCommitteeLabels, excludeCouncils, darkMode, renderYear]);

  useEffect(() => {
    applyVisualState();
  }, [searchTerm, selected, egoOnly, showCommitteeLabels]);

  if (error && !needsFile) {
    return (
      <div style={{ padding: 20, fontFamily: 'system-ui', color: palette.highlight, background: palette.bg, minHeight: '100vh' }}>
        Error loading data: {error}
      </div>
    );
  }

  if (needsFile) {
    return (
      <div style={{
        padding: 20, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        color: palette.text, background: palette.bg, minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>
        <div style={{
          maxWidth: 460, padding: '24px 28px', background: palette.surface,
          border: '0.5px solid ' + palette.border, borderRadius: 12, textAlign: 'center'
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 500, margin: '0 0 8px' }}>Load committee data</h2>
          <p style={{ fontSize: 13, color: palette.textMuted, lineHeight: 1.5, margin: '0 0 18px' }}>
            This visualization needs the committee membership CSV. Choose the file from your computer to load it.
          </p>
          <label style={{
            display: 'inline-block', padding: '8px 16px', background: palette.accent,
            color: '#ffffff', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500
          }}>
            Choose CSV file
            <input type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (f) handleFileInput(f);
              }} />
          </label>
          {error && (
            <p style={{ fontSize: 12, color: palette.highlight, marginTop: 14 }}>{error}</p>
          )}
          <p style={{ fontSize: 11, color: palette.textFaint, marginTop: 16, lineHeight: 1.5 }}>
            Expected columns: Year, Committee, Capacity, Quarters, Last Name, First Name, Department
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        padding: 20, fontFamily: 'system-ui', color: palette.textMuted,
        background: palette.bg, minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 14, height: 14, borderRadius: '50%',
            border: '1.5px solid ' + palette.border, borderTopColor: palette.accent,
            animation: 'spin 0.7s linear infinite'
          }} />
          <span style={{ fontSize: 13 }}>{statusMsg}</span>
        </div>
        <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
      </div>
    );
  }

  const sortedDepts = [...info.deptCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topDepts = sortedDepts.slice(0, 18);
  const moreDepts = sortedDepts.length - topDepts.length;
  const currentYear = idx.years[yearIdx];

  const baseBtn = {
    fontFamily: 'inherit', fontSize: 12, background: 'transparent',
    color: palette.text, border: '0.5px solid ' + palette.border,
    borderRadius: 6, padding: '5px 10px', cursor: 'pointer'
  };
  const activeBtn = { ...baseBtn, background: palette.surface, borderColor: palette.text };

  return (
    <div style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      background: palette.bg, color: palette.text,
      height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        padding: '10px 16px', borderBottom: '0.5px solid ' + palette.border,
        background: palette.surface, flexShrink: 0
      }}>
        <h1 style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>
          UCSD Academic Senate · committee co-membership network
        </h1>
        <div style={{ fontSize: 12, color: palette.textMuted }}>{statusMsg}</div>
      </div>

      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '12px 16px', alignItems: 'center',
        padding: '10px 16px', background: palette.surface,
        borderBottom: '0.5px solid ' + palette.border, flexShrink: 0
      }}>
        <div style={{ fontSize: 18, fontWeight: 500, minWidth: 90 }}>
          {formatYear(currentYear)}
        </div>
        <input
          type="range" min={0} max={idx.years.length - 1} step={1}
          value={yearIdx}
          onChange={e => setYearIdx(parseInt(e.target.value, 10))}
          style={{ width: 240, accentColor: palette.accent }}
        />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: palette.textMuted }}>ties:</span>
          {['current', 'repeated', 'former'].map(t => (
            <button
              key={t}
              style={edgeFilter[t] ? activeBtn : baseBtn}
              onClick={() => setEdgeFilter(f => ({ ...f, [t]: !f[t] }))}
            >{t}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: palette.textMuted }}>search:</span>
          <input
            type="text" placeholder="last name..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{
              fontFamily: 'inherit', fontSize: 12, background: palette.surface,
              color: palette.text, border: '0.5px solid ' + palette.border,
              borderRadius: 6, padding: '4px 8px', width: 130
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12, color: palette.textMuted }}>
            <input type="checkbox" checked={showNodeLabels}
              onChange={e => setShowNodeLabels(e.target.checked)}
              style={{ accentColor: palette.accent }} />
            node labels
          </label>
          <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12, color: palette.textMuted }}>
            <input type="checkbox" checked={showCommitteeLabels}
              onChange={e => setShowCommitteeLabels(e.target.checked)}
              style={{ accentColor: palette.accent }} />
            committee labels
          </label>
          <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12, color: palette.textMuted }}>
            <input type="checkbox" checked={excludeCouncils}
              onChange={e => setExcludeCouncils(e.target.checked)}
              style={{ accentColor: palette.accent }} />
            exclude councils
          </label>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: palette.textMuted }}>spacing:</span>
          <input type="range" min={0.3} max={3.0} step={0.05}
            value={spread}
            onChange={e => setSpread(parseFloat(e.target.value))}
            style={{ width: 110, accentColor: palette.accent }} />
          <span style={{ fontSize: 11, color: palette.textFaint, minWidth: 28, textAlign: 'right' }}>
            {spread.toFixed(2)}\u00d7
          </span>
        </div>
        <button
          style={baseBtn}
          onClick={() => {
            nodePositionsRef.current.clear();
            networkCacheRef.current.clear();
            renderYear(currentYear, false);
            if (svgRef.current && zoomRef.current) {
              d3.select(svgRef.current).transition().duration(500)
                .call(zoomRef.current.transform, d3.zoomIdentity);
            }
          }}
        >reset layout</button>
      </div>

      <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', background: palette.bg }}>
        <svg ref={svgRef} style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab' }} />

        {selected && (
          <div style={{
            position: 'absolute', top: 10, left: 10,
            background: palette.surface, border: '0.5px solid ' + palette.selected,
            borderRadius: 8, padding: '10px 12px',
            fontSize: 12, maxWidth: 300, maxHeight: 'calc(100vh - 220px)',
            overflowY: 'auto', color: palette.text
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{selected.name}</div>
                <div style={{ fontSize: 11, color: palette.textMuted, marginTop: 2 }}>{selected.dept}</div>
              </div>
              <button
                onClick={() => {
                  selectedRef.current = null;
                  setSelected(null);
                  setEgoOnly(false);
                  egoOnlyRef.current = false;
                  applyVisualState();
                }}
                style={{ ...baseBtn, padding: '2px 8px', fontSize: 11, lineHeight: 1 }}
              >\u2715</button>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: palette.textMuted }}>
              {neighborCount} tie{neighborCount === 1 ? '' : 's'} in {formatYear(currentYear)}
              <span style={{ color: palette.textFaint }}> \u00b7 active {selected.firstYear}\u2013{selected.lastYear}</span>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button style={egoOnly ? activeBtn : baseBtn} onClick={() => setEgoOnly(v => !v)}>
                {egoOnly ? 'show all' : 'isolate ego'}
              </button>
            </div>
            {(() => {
              const yMap = selected.byYear.get(currentYear);
              const cmts = yMap
                ? [...yMap.entries()].filter(([c]) => !(excludeCouncils && isCouncil(c)))
                : [];
              if (cmts.length === 0) return null;
              return (
                <div style={{ marginTop: 10, fontSize: 11, color: palette.textMuted, borderTop: '0.5px solid ' + palette.border, paddingTop: 8 }}>
                  <div style={{ color: palette.textFaint, marginBottom: 4 }}>committees this year:</div>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {cmts.map(([c, cap]) => (
                      <li key={c}>{c}{cap ? <span style={{ color: palette.textFaint }}> \u00b7 {cap}</span> : null}</li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            {(() => {
              const yrs = [...selected.byYear.keys()].filter(y => y <= currentYear).sort();
              const items = [];
              for (const y of yrs) {
                const m = selected.byYear.get(y);
                const list = [...m.keys()].filter(c => !(excludeCouncils && isCouncil(c)));
                if (list.length === 0) continue;
                items.push({ y, list });
              }
              if (items.length === 0) return null;
              return (
                <div style={{ marginTop: 10, fontSize: 11, color: palette.textMuted, borderTop: '0.5px solid ' + palette.border, paddingTop: 8 }}>
                  <div style={{ color: palette.textFaint, marginBottom: 4 }}>full history through {formatYear(currentYear)}:</div>
                  <ul style={{ margin: 0, paddingLeft: 16, lineHeight: 1.45 }}>
                    {items.map(({ y, list }) => (
                      <li key={y}>
                        <span style={{ color: palette.text }}>{formatYear(y)}</span> &mdash; {list.join('; ')}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </div>
        )}

        <div style={{
          position: 'absolute', top: 10, right: 10,
          background: palette.surface, border: '0.5px solid ' + palette.border,
          borderRadius: 8, padding: '8px 10px',
          fontSize: 11, maxWidth: 220, maxHeight: '70%', overflowY: 'auto'
        }}>
          <div style={{ marginBottom: 8 }}>
            <h3 style={{
              fontSize: 11, fontWeight: 500, margin: '0 0 4px',
              color: palette.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em'
            }}>tie type</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0' }}>
              <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '3px solid ' + palette.repeated }} />
              repeated co-member
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0' }}>
              <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '1.5px solid ' + palette.current }} />
              current co-member
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0' }}>
              <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '1px dashed ' + palette.former }} />
              former co-member
            </div>
          </div>
          <div>
            <h3 style={{
              fontSize: 11, fontWeight: 500, margin: '0 0 4px',
              color: palette.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em'
            }}>departments (top)</h3>
            {topDepts.map(([d, c]) => (
              <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0', lineHeight: 1.3 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: hashColor(d), flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d}</span>
                <span style={{ color: palette.textFaint, marginLeft: 'auto' }}>{c}</span>
              </div>
            ))}
            {moreDepts > 0 && (
              <div style={{ color: palette.textFaint, marginTop: 4 }}>+ {moreDepts} more (also colored)</div>
            )}
          </div>
        </div>

        <div style={{
          position: 'absolute', bottom: 10, left: 10,
          background: palette.surface, border: '0.5px solid ' + palette.border,
          borderRadius: 8, padding: '8px 10px',
          fontSize: 11, color: palette.textMuted, pointerEvents: 'none'
        }}>
          <span style={{ fontWeight: 500, color: palette.text }}>{info.nodes}</span> active members &nbsp;·&nbsp;
          <span style={{ fontWeight: 500, color: palette.text }}>{info.edges}</span> ties shown
          <br />
          <span style={{ color: palette.textFaint }}>click node to pin · drag to move · scroll to zoom</span>
        </div>

        {tooltip.visible && containerRef.current && (
          <div style={{
            position: 'absolute',
            left: Math.min(tooltip.x + 12, containerRef.current.getBoundingClientRect().width - 320),
            top: Math.min(tooltip.y + 12, containerRef.current.getBoundingClientRect().height - 200),
            pointerEvents: 'none',
            background: palette.surface, border: '0.5px solid ' + palette.border,
            borderRadius: 6, padding: '8px 10px',
            fontSize: 11, maxWidth: 320, color: palette.text,
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
          }} dangerouslySetInnerHTML={{ __html: tooltip.html }} />
        )}
      </div>
    </div>
  );
}