import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatMetric, METRIC_LABELS, type Metrics } from '../metrics';

interface RefData {
  label: string;
  metrics: Record<string, number | null>;
}

export interface MetricsPanelProps {
  metrics: Metrics;
  level: number;
  columnLabel: string;
}

/** Metrics table with a reference column: corpus average of the same level,
 *  or a specific corpus chart found via search. */
export default function MetricsPanel({ metrics, level, columnLabel }: MetricsPanelProps) {
  const [mode, setMode] = useState<'level' | 'chart'>('level');
  const [reference, setReference] = useState<RefData | null>(null);
  const [query, setQuery] = useState('');
  const [anyLevel, setAnyLevel] = useState(false);
  const [results, setResults] = useState<{ id: number; title: string; meter: number }[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (mode !== 'level') return;
    let cancelled = false;
    api.referenceLevel(level)
      .then((r) => !cancelled && (setReference({
        label: `avg lvl ${r.level} (${r.count} charts)`,
        metrics: r.metrics,
      }), setUnavailable(false)))
      .catch(() => !cancelled && (setReference(null), setUnavailable(true)));
    return () => { cancelled = true; };
  }, [mode, level]);

  useEffect(() => {
    if (mode !== 'chart' || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.referenceSearch(query, anyLevel ? undefined : level)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [mode, query, anyLevel, level]);

  const pick = async (id: number) => {
    setResults([]);
    setQuery('');
    try {
      const c = await api.referenceChart(id);
      setReference({ label: `${c.title} S${c.meter}`, metrics: c.metrics });
    } catch { /* keep previous */ }
  };

  const rows = useMemo(
    () => METRIC_LABELS.map(([key, label]) => ({
      key,
      label,
      mine: formatMetric(key, metrics[key] as number | null),
      ref: reference ? formatMetric(key, reference.metrics[key]) : '—',
    })),
    [metrics, reference],
  );

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button
          className={mode === 'level' ? 'active' : ''}
          onClick={() => setMode('level')}
          style={{ padding: '3px 9px', fontSize: 12 }}
        >
          vs level avg
        </button>
        <button
          className={mode === 'chart' ? 'active' : ''}
          onClick={() => setMode('chart')}
          style={{ padding: '3px 9px', fontSize: 12 }}
        >
          vs song…
        </button>
      </div>

      {mode === 'chart' && (
        <div style={{ position: 'relative', marginBottom: 6 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <input
              placeholder="search corpus songs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <label className="muted" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={anyLevel} onChange={(e) => setAnyLevel(e.target.checked)} />
            {' '}any level (not just {level})
          </label>
          {results.length > 0 && (
            <div
              style={{
                position: 'absolute', zIndex: 5, left: 0, right: 0, top: 30,
                background: 'var(--panel-2)', border: '1px solid var(--line)',
                borderRadius: 6, maxHeight: 200, overflowY: 'auto',
              }}
            >
              {results.map((r) => (
                <div
                  key={`${r.id}`}
                  onClick={() => void pick(r.id)}
                  style={{ padding: '5px 9px', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(90,140,255,0.15)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                >
                  {r.title} <span className="muted">S{r.meter}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <table className="stats metrics-compare">
        <thead>
          <tr>
            <th>metric</th>
            <th>{columnLabel}</th>
            <th>{reference?.label ?? (unavailable ? 'no corpus data' : '…')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="muted">{r.label}</td>
              <td>{r.mine}</td>
              <td className="muted">{r.ref}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
