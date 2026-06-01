/**
 * Custom tool cards for the Knowledge Graph MCP server (sm-mcp).
 * Registered via `runtime/register-kg-renderers.ts`. ToolCard's lookup
 * ladder consults the registry first, so these cards take precedence
 * over the generic fallback for `kg_search`, `kg_get_node`,
 * `kg_subgraph` (and their `mcp__sm-mcp__*` prefixed forms).
 *
 * Visual styling lives in `KgToolCards.module.css`; the shared
 * `.op-card` / `.op-card-head` global classes (declared in
 * `styles/viewer/tools.css`) provide border + background + padding so
 * the cards match the rest of the assistant tool stream.
 *
 * Renderer callbacks in tool-renderers must be hook-free; cards with
 * internal state are mounted as elements from `register-kg-renderers`.
 */
import { useState, type ReactNode } from 'react';
import type { ToolRenderProps } from '../runtime/tool-renderers';
import styles from './KgToolCards.module.css';

type Json = unknown;

function tryParseJson(value: string | undefined): Json {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

// MCP tools wrap the actual payload in a content array of {type,text}.
// Some agents already flatten this; handle both.
function unwrapMcpContent(parsed: Json): Json {
  if (parsed && typeof parsed === 'object' && 'content' in (parsed as Record<string, unknown>)) {
    const inner = (parsed as { content?: unknown }).content;
    if (Array.isArray(inner) && inner.length > 0) {
      const first = inner[0] as { type?: string; text?: string };
      if (first && first.type === 'text' && typeof first.text === 'string') {
        return tryParseJson(first.text);
      }
    }
  }
  return parsed;
}

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ─── Atoms ─────────────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: ToolRenderProps['status'] }) {
  const label =
    status === 'executing' || status === 'inProgress'
      ? 'running'
      : status === 'error'
        ? 'error'
        : 'done';
  const kind =
    status === 'error'
      ? styles.error
      : status === 'complete'
        ? styles.complete
        : styles.running;
  return <span className={classNames(styles.statusBadge, kind)}>{label}</span>;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={classNames(styles.copyBtn, copied && styles.copied)}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {
            /* silent: clipboard API may be unavailable */
          });
      }}
      title={copied ? 'Copied' : 'Copy id'}
      aria-label={copied ? 'Copied' : 'Copy id'}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

function MonoId({ value }: { value: string }) {
  return (
    <span className={styles.idRow}>
      <code className={styles.id} title={value}>
        {value}
      </code>
      <CopyButton value={value} />
    </span>
  );
}

function Skeleton({ lines = 3 }: { lines?: number }) {
  const pattern = [styles.medium, styles.short, styles.medium];
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={classNames(styles.skelLine, pattern[i % pattern.length])} />
      ))}
    </div>
  );
}

function RawJsonAccordion({ data, label = 'raw JSON' }: { data: Json; label?: string }) {
  return (
    <details className={styles.rawDetails}>
      <summary className={styles.rawSummary}>{label}</summary>
      <pre className={styles.rawPre}>
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function ErrorBox({ message }: { message: string }) {
  return <div className={styles.errorBox}>{message}</div>;
}

function CardShell({
  icon,
  title,
  subtitle,
  status,
  children,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  status: ToolRenderProps['status'];
  children: ReactNode;
}) {
  return (
    <div className="op-card">
      <div className={classNames('op-card-head', styles.head)}>
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
        <span className={styles.title}>{title}</span>
        {subtitle && <span className={styles.subtitle}>· {subtitle}</span>}
        <StatusBadge status={status} />
      </div>
      {children}
    </div>
  );
}

/* ─── kg_search ─────────────────────────────────────────────────────── */

interface KgHit {
  id?: string;
  node_id?: string;
  label?: string;
  name?: string;
  title?: string;
  score?: number;
  kind?: string;
  category?: string;
  type?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

function extractHits(parsed: Json): KgHit[] | null {
  const unwrapped = unwrapMcpContent(parsed);
  if (Array.isArray(unwrapped)) return unwrapped as KgHit[];
  if (unwrapped && typeof unwrapped === 'object') {
    const obj = unwrapped as Record<string, unknown>;
    for (const key of ['hits', 'results', 'nodes', 'items', 'data']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as KgHit[];
    }
  }
  return null;
}

function hitId(h: KgHit): string {
  return String(h.id ?? h.node_id ?? '');
}
function hitLabel(h: KgHit): string {
  return String(h.label ?? h.name ?? h.title ?? hitId(h) ?? 'untitled');
}
function hitKind(h: KgHit): string | undefined {
  const k = h.kind ?? h.category ?? h.type;
  return k ? String(k) : undefined;
}

export function KgSearchCard(props: ToolRenderProps) {
  const args = (props.args ?? {}) as { query?: string; limit?: number };
  const query = String(args.query ?? '');
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  const parsed = tryParseJson(props.result);
  const hits = extractHits(parsed);
  const [expanded, setExpanded] = useState(false);

  const subtitle = limit ? `limit ${limit}` : undefined;
  const visible = hits ? (expanded ? hits : hits.slice(0, 5)) : [];
  const isLoading = props.status === 'executing' || props.status === 'inProgress';

  return (
    <CardShell icon="⌕" title="KG search" subtitle={subtitle} status={props.status}>
      {query && <div className={styles.queryBox}>"{query}"</div>}
      {isLoading && <Skeleton lines={4} />}
      {props.isError && <ErrorBox message={String(props.result ?? 'Search failed')} />}
      {!props.isError && !isLoading && hits && (
        <>
          <div className={styles.counts}>
            {hits.length} {hits.length === 1 ? 'hit' : 'hits'}
          </div>
          <div className={styles.hits}>
            {visible.map((h, i) => (
              <div key={hitId(h) || i} className={styles.hit}>
                <div className={styles.hitHeader}>
                  <span className={styles.hitLabel}>{hitLabel(h)}</span>
                  {typeof h.score === 'number' && (
                    <span className={styles.score}>score {h.score.toFixed(2)}</span>
                  )}
                </div>
                {hitKind(h) && <span className={styles.kind}>{hitKind(h)}</span>}
                {hitId(h) && <MonoId value={hitId(h)} />}
              </div>
            ))}
          </div>
          {hits.length > 5 && (
            <button
              type="button"
              className={styles.showMore}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? '▴ Show less' : `▾ Show ${hits.length - 5} more`}
            </button>
          )}
        </>
      )}
      {!props.isError && !isLoading && !hits && props.status === 'complete' && (
        <div className={styles.empty}>No structured hits found in response.</div>
      )}
      {parsed != null && !isLoading && <RawJsonAccordion data={parsed} />}
    </CardShell>
  );
}

/* ─── kg_get_node ───────────────────────────────────────────────────── */

function extractNode(parsed: Json): Record<string, unknown> | null {
  const unwrapped = unwrapMcpContent(parsed);
  if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
    const obj = unwrapped as Record<string, unknown>;
    if (obj.node && typeof obj.node === 'object') return obj.node as Record<string, unknown>;
    return obj;
  }
  return null;
}

function formatValue(v: unknown): { text: string; mono: boolean } {
  if (typeof v === 'string') return { text: v, mono: false };
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v), mono: false };
  if (v === null || v === undefined) return { text: '—', mono: false };
  return { text: JSON.stringify(v), mono: true };
}

export function KgGetNodeCard(props: ToolRenderProps) {
  const args = (props.args ?? {}) as { node_id?: string };
  const nodeId = String(args.node_id ?? '');
  const parsed = tryParseJson(props.result);
  const node = extractNode(parsed);
  const label = node ? String(node.label ?? node.name ?? node.title ?? nodeId) : nodeId;

  const properties: Array<[string, unknown]> = node
    ? Object.entries(node).filter(
        ([k]) => !['label', 'name', 'title', 'id', 'node_id'].includes(k),
      )
    : [];
  const isLoading = props.status === 'executing' || props.status === 'inProgress';

  return (
    <CardShell icon="◉" title="KG node" subtitle={label || undefined} status={props.status}>
      <div className={styles.nodeHeader}>{nodeId && <MonoId value={nodeId} />}</div>
      {isLoading && <Skeleton lines={5} />}
      {props.isError && <ErrorBox message={String(props.result ?? 'Fetch failed')} />}
      {!props.isError && !isLoading && properties.length > 0 && (
        <table className={styles.propsTable}>
          <tbody>
            {properties.map(([k, v]) => {
              const f = formatValue(v);
              return (
                <tr key={k}>
                  <td className={styles.propsKey}>{k}</td>
                  <td className={classNames(styles.propsVal, f.mono && styles.mono)}>
                    {f.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {!props.isError && !isLoading && properties.length === 0 && props.status === 'complete' && (
        <div className={styles.empty}>No properties in response.</div>
      )}
      {parsed != null && !isLoading && <RawJsonAccordion data={parsed} />}
    </CardShell>
  );
}

/* ─── shared graph helpers ──────────────────────────────────────────── */

interface KgEdge {
  source?: string;
  target?: string;
  from?: string;
  to?: string;
  relation?: string;
  type?: string;
  label?: string;
  [k: string]: unknown;
}

function extractGraph(parsed: Json): { nodes: KgHit[]; edges: KgEdge[] } | null {
  const unwrapped = unwrapMcpContent(parsed);
  if (!unwrapped || typeof unwrapped !== 'object') return null;
  const obj = unwrapped as Record<string, unknown>;
  const nodes = Array.isArray(obj.nodes) ? (obj.nodes as KgHit[]) : [];
  const edges = Array.isArray(obj.edges) ? (obj.edges as KgEdge[]) : [];
  if (nodes.length === 0 && edges.length === 0) return null;
  return { nodes, edges };
}

function edgeRel(e: KgEdge): string {
  return String(e.relation ?? e.type ?? e.label ?? '—');
}

function edgeSourceId(e: KgEdge): string {
  return String(e.source ?? e.from ?? '');
}
function edgeTargetId(e: KgEdge): string {
  return String(e.target ?? e.to ?? '');
}

/* ─── kg_subgraph (induced graph over a list of node ids) ───────────── */

export function KgSubgraphCard(props: ToolRenderProps) {
  const args = (props.args ?? {}) as { node_ids?: unknown };
  const inputIds = Array.isArray(args.node_ids)
    ? args.node_ids.filter((v): v is string => typeof v === 'string')
    : [];
  const parsed = tryParseJson(props.result);
  const graph = extractGraph(parsed);

  const nodeById = new Map<string, KgHit>();
  if (graph) {
    for (const n of graph.nodes) {
      const id = hitId(n);
      if (id) nodeById.set(id, n);
    }
  }
  const labelOf = (id: string): string => {
    const n = nodeById.get(id);
    return n ? hitLabel(n) : id.slice(0, 8) + '…';
  };
  const isLoading = props.status === 'executing' || props.status === 'inProgress';
  const subtitle = inputIds.length
    ? `${inputIds.length} input ${inputIds.length === 1 ? 'id' : 'ids'}`
    : undefined;

  return (
    <CardShell icon="⤫" title="KG subgraph" subtitle={subtitle} status={props.status}>
      {inputIds.length > 0 && (
        <div className={styles.rootBox}>
          <span className={styles.rootLabel}>input ids</span>
          <div className={styles.hits} style={{ marginTop: 4 }}>
            {inputIds.map((id) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={styles.edgeNode}>● {labelOf(id)}</span>
                <MonoId value={id} />
              </div>
            ))}
          </div>
        </div>
      )}
      {isLoading && <Skeleton lines={4} />}
      {props.isError && <ErrorBox message={String(props.result ?? 'Subgraph failed')} />}
      {!props.isError && !isLoading && graph && (
        <>
          <div className={styles.counts}>
            {graph.nodes.length} nodes · {graph.edges.length} edges
          </div>
          {graph.edges.length > 0 && (
            <div className={styles.edgeList}>
              {graph.edges.map((e, i) => {
                const s = edgeSourceId(e);
                const t = edgeTargetId(e);
                return (
                  <div key={i} className={styles.edge}>
                    <span className={styles.edgeArrow}>
                      ● {labelOf(s)} ──{edgeRel(e)}──▶
                    </span>
                    <span className={styles.edgeNode}>● {labelOf(t)}</span>
                    <span />
                  </div>
                );
              })}
            </div>
          )}
          {graph.edges.length === 0 && graph.nodes.length > 0 && (
            <div className={styles.empty}>
              {graph.nodes.length} nodes returned, no edges between them.
            </div>
          )}
        </>
      )}
      {parsed != null && !isLoading && <RawJsonAccordion data={parsed} />}
    </CardShell>
  );
}

/* ─── kg_describe_schema (live Neo4j schema) ────────────────────────── */

interface SchemaLabel {
  label?: string;
  count?: number;
  keys?: string[];
}
interface SchemaRel {
  type?: string;
  count?: number;
}
interface SchemaTriple {
  from?: string;
  rel?: string;
  to?: string;
  count?: number;
}
interface SchemaExample {
  task?: string;
  cypher?: string;
}
interface KgSchema {
  labels?: SchemaLabel[];
  relationshipTypes?: SchemaRel[];
  topTriples?: SchemaTriple[];
  conventions?: Record<string, string>;
  examples?: SchemaExample[];
  limits?: Record<string, unknown>;
}

function extractSchema(parsed: Json): KgSchema | null {
  const unwrapped = unwrapMcpContent(parsed);
  if (!unwrapped || typeof unwrapped !== 'object') return null;
  const obj = unwrapped as KgSchema;
  if (!obj.labels && !obj.relationshipTypes) return null;
  return obj;
}

export function KgSchemaCard(props: ToolRenderProps) {
  const parsed = tryParseJson(props.result);
  const schema = extractSchema(parsed);
  const isLoading = props.status === 'executing' || props.status === 'inProgress';

  const labels = (schema?.labels ?? [])
    .slice()
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const rels = (schema?.relationshipTypes ?? [])
    .slice()
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const triples = schema?.topTriples ?? [];
  const examples = schema?.examples ?? [];
  const maxLabelCount = labels.reduce((m, l) => Math.max(m, l.count ?? 0), 1);

  const subtitle = schema
    ? `${labels.length} labels · ${rels.length} rels`
    : undefined;

  return (
    <CardShell icon="▦" title="KG schema" subtitle={subtitle} status={props.status}>
      {isLoading && <Skeleton lines={6} />}
      {props.isError && <ErrorBox message={String(props.result ?? 'Schema fetch failed')} />}
      {!props.isError && !isLoading && schema && (
        <>
          {labels.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>Labels ({labels.length})</div>
              <div className={styles.schemaGrid}>
                {labels.map((l) => {
                  const pct = Math.round(((l.count ?? 0) / maxLabelCount) * 60);
                  return (
                    <div key={l.label} className={styles.schemaRow}>
                      <span className={styles.schemaLabelName}>{l.label}</span>
                      <span
                        className={styles.schemaBar}
                        style={{ width: `${Math.max(4, pct)}px` }}
                      />
                      <span className={styles.schemaCount}>
                        {(l.count ?? 0).toLocaleString()}
                      </span>
                      {l.keys && l.keys.length > 0 && (
                        <span className={styles.schemaKeys} title={l.keys.join(', ')}>
                          {l.keys.slice(0, 4).join(', ')}
                          {l.keys.length > 4 ? '…' : ''}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {rels.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>
                Relationship types ({rels.length})
              </div>
              <div className={styles.manualChips}>
                {rels.map((r) => (
                  <span key={r.type} className={styles.manualChip}>
                    {r.type}
                    <span style={{ opacity: 0.6 }}>{(r.count ?? 0).toLocaleString()}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {triples.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>
                Top triples ({triples.length})
              </div>
              <div>
                {triples.map((t, i) => (
                  <div key={i} className={styles.tripleRow}>
                    <span className={styles.tripleNode}>{t.from}</span>
                    <span className={styles.tripleRel}>─{t.rel}─▶</span>
                    <span className={styles.tripleNode}>{t.to}</span>
                    <span className={styles.tripleCount}>
                      {(t.count ?? 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {examples.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>
                Example queries ({examples.length})
              </div>
              {examples.map((ex, i) => (
                <details key={i} className={styles.exampleItem}>
                  <summary className={styles.exampleTask}>{ex.task}</summary>
                  <pre className={styles.exampleCypher}>{ex.cypher}</pre>
                </details>
              ))}
            </div>
          )}

          {schema.conventions && Object.keys(schema.conventions).length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>Conventions</div>
              <ul className={styles.manualTipList}>
                {Object.entries(schema.conventions).map(([k, v]) => (
                  <li key={k}>
                    <strong>{k}:</strong> {v}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {parsed != null && !isLoading && <RawJsonAccordion data={parsed} />}
    </CardShell>
  );
}

/* ─── kg_cypher_read (raw Cypher rows) ──────────────────────────────── */

interface CypherResult {
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
  capped?: boolean;
}

function extractCypher(parsed: Json): CypherResult | null {
  const unwrapped = unwrapMcpContent(parsed);
  if (!unwrapped || typeof unwrapped !== 'object') return null;
  const obj = unwrapped as CypherResult;
  if (!Array.isArray(obj.rows)) return null;
  return obj;
}

function cellText(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function KgCypherCard(props: ToolRenderProps) {
  const args = (props.args ?? {}) as { cypher?: string };
  const cypher = String(args.cypher ?? '');
  const parsed = tryParseJson(props.result);
  const result = extractCypher(parsed);
  const isLoading = props.status === 'executing' || props.status === 'inProgress';

  const rows = result?.rows ?? [];
  // Union of keys across rows preserves column order from the first row,
  // then appends any extra keys later rows introduce.
  const columns: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!columns.includes(k)) columns.push(k);
    }
  }
  const subtitle = result ? `${result.rowCount ?? rows.length} rows` : undefined;

  return (
    <CardShell icon="⌘" title="KG cypher" subtitle={subtitle} status={props.status}>
      {cypher && <pre className={styles.cypherQuery}>{cypher}</pre>}
      {isLoading && <Skeleton lines={4} />}
      {props.isError && <ErrorBox message={String(props.result ?? 'Query failed')} />}
      {!props.isError && !isLoading && result && (
        <>
          <div className={styles.counts}>
            {result.rowCount ?? rows.length} rows
            {result.capped && <span className={styles.cappedBadge}>capped 200</span>}
          </div>
          {rows.length > 0 ? (
            <div className={styles.rowsTableWrap}>
              <table className={styles.rowsTable}>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 50).map((row, i) => (
                    <tr key={i}>
                      {columns.map((c) => (
                        <td key={c} title={cellText(row[c])}>
                          {cellText(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.empty}>Query returned 0 rows.</div>
          )}
          {rows.length > 50 && (
            <div className={styles.counts} style={{ marginTop: 6 }}>
              showing first 50 of {rows.length}
            </div>
          )}
        </>
      )}
      {parsed != null && !isLoading && <RawJsonAccordion data={parsed} />}
    </CardShell>
  );
}

/* ─── kg_describe (curated KGS manual) ──────────────────────────────── */

interface KgManualLabel {
  name?: string;
  description?: string;
  keyProps?: string[];
  nextHop?: string;
}
interface KgManualEdge {
  type?: string;
  from?: string;
  to?: string;
  description?: string;
  props?: string[];
}
interface KgManualWorkspace {
  id?: string;
  description?: string;
}
interface KgManualRecipe {
  name?: string;
  goal?: string;
  steps?: string[];
  useWhen?: string;
}
interface KgManual {
  name?: string;
  summary?: string;
  labels?: KgManualLabel[];
  edges?: KgManualEdge[];
  workspaces?: KgManualWorkspace[];
  recipes?: KgManualRecipe[];
  searchTips?: string[];
  antiPatterns?: string[];
}

function extractManual(parsed: Json): KgManual | null {
  const unwrapped = unwrapMcpContent(parsed);
  if (!unwrapped || typeof unwrapped !== 'object') return null;
  return unwrapped as KgManual;
}

export function KgDescribeCard(props: ToolRenderProps) {
  const args = (props.args ?? {}) as { domain?: string };
  const domain = String(args.domain ?? 'UI');
  const parsed = tryParseJson(props.result);
  const manual = extractManual(parsed);
  const isLoading = props.status === 'executing' || props.status === 'inProgress';

  const subtitle = manual
    ? `${manual.labels?.length ?? 0} labels · ${manual.recipes?.length ?? 0} recipes`
    : domain;

  return (
    <CardShell icon="📖" title="KG manual" subtitle={subtitle} status={props.status}>
      {isLoading && <Skeleton lines={6} />}
      {props.isError && <ErrorBox message={String(props.result ?? 'Describe failed')} />}
      {!props.isError && !isLoading && manual && (
        <>
          {manual.summary && <div className={styles.manualSummary}>{manual.summary}</div>}

          {manual.labels && manual.labels.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>
                Labels ({manual.labels.length})
              </div>
              <div className={styles.manualChips}>
                {manual.labels.map((l) => (
                  <span
                    key={l.name}
                    className={styles.manualChip}
                    title={l.description}
                  >
                    {l.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {manual.edges && manual.edges.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>
                Edges ({manual.edges.length})
              </div>
              <div className={styles.manualEdgeList}>
                {manual.edges.map((e, i) => (
                  <div key={i} className={styles.manualEdgeItem}>
                    <div className={styles.manualEdgeRow}>
                      <span>{e.from}</span>
                      <span className={styles.manualEdgeArrow}>──{e.type}──▶</span>
                      <span>{e.to}</span>
                    </div>
                    {e.description && (
                      <div className={styles.manualWsDesc}>{e.description}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {manual.workspaces && manual.workspaces.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>
                Workspaces ({manual.workspaces.length})
              </div>
              <div className={styles.manualWsList}>
                {manual.workspaces.map((w) => (
                  <div key={w.id} className={styles.manualWsItem}>
                    <span className={styles.manualWsId}>{w.id}</span>
                    {w.description && (
                      <div className={styles.manualWsDesc}>{w.description}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {manual.recipes && manual.recipes.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>
                Recipes ({manual.recipes.length})
              </div>
              {manual.recipes.map((r, i) => (
                <details key={r.name ?? i} className={styles.manualRecipe}>
                  <summary className={styles.manualRecipeHead}>
                    <span className={styles.manualRecipeName}>{r.name}</span>
                    {r.goal && <span className={styles.manualRecipeGoal}>{r.goal}</span>}
                  </summary>
                  <div className={styles.manualRecipeBody}>
                    {r.steps && r.steps.length > 0 && (
                      <ol>
                        {r.steps.map((s, si) => (
                          <li key={si}>{s}</li>
                        ))}
                      </ol>
                    )}
                    {r.useWhen && (
                      <div className={styles.manualRecipeUseWhen}>
                        <strong>Use when:</strong> {r.useWhen}
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}

          {manual.searchTips && manual.searchTips.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>Search tips</div>
              <ul className={styles.manualTipList}>
                {manual.searchTips.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          )}

          {manual.antiPatterns && manual.antiPatterns.length > 0 && (
            <div className={styles.manualSection}>
              <div className={styles.manualSectionTitle}>Anti-patterns</div>
              <ul className={styles.manualAntiList}>
                {manual.antiPatterns.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
      {parsed != null && !isLoading && <RawJsonAccordion data={parsed} />}
    </CardShell>
  );
}

/* ─── kg_get_theme_composition (brand-ready theme view) ─────────────── */

interface KgToken {
  id?: string;
  path?: string;
  rawValue?: unknown;
  targetType?: string;
  [k: string]: unknown;
}

interface KgThemeLayer {
  order?: number;
  theme?: {
    id?: string;
    name?: string;
    slug?: string;
    kind?: string;
  };
  tokens?: KgToken[];
}

interface KgThemeComposition {
  composition?: {
    id?: string;
    name?: string;
    workspaceId?: string;
    isActive?: boolean;
  };
  layers?: KgThemeLayer[];
}

function extractComposition(parsed: Json): KgThemeComposition | null {
  const unwrapped = unwrapMcpContent(parsed);
  if (!unwrapped || typeof unwrapped !== 'object') return null;
  const obj = unwrapped as Record<string, unknown>;
  if (!obj.composition && !obj.layers) return null;
  return unwrapped as KgThemeComposition;
}

// Detect whether a token's rawValue looks like a CSS color so we can
// render a swatch next to it. Recognizes hex, hsl(...), rgb(...), and
// named keywords. False negatives are fine — the swatch is purely
// decorative and the value stays visible as text either way.
function colorSwatchValue(token: KgToken): string | null {
  if (token.targetType && String(token.targetType).toLowerCase().includes('color')) {
    if (typeof token.rawValue === 'string' && token.rawValue.trim()) {
      return token.rawValue.trim();
    }
  }
  if (typeof token.rawValue !== 'string') return null;
  const v = token.rawValue.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^(hsla?|rgba?|color|oklch|oklab)\s*\(/i.test(v)) return v;
  return null;
}

function tokenValueText(token: KgToken): string {
  if (typeof token.rawValue === 'string') return token.rawValue;
  if (token.rawValue == null) return '—';
  return JSON.stringify(token.rawValue);
}

export function KgThemeCompositionCard(props: ToolRenderProps) {
  const args = (props.args ?? {}) as { composition_id?: string };
  const compId = String(args.composition_id ?? '');
  const parsed = tryParseJson(props.result);
  const data = extractComposition(parsed);
  const composition = data?.composition;
  const layers = (data?.layers ?? []).slice().sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  const isLoading = props.status === 'executing' || props.status === 'inProgress';

  const totalTokens = layers.reduce(
    (n, l) => n + (Array.isArray(l.tokens) ? l.tokens.length : 0),
    0,
  );
  const subtitle = composition
    ? `${layers.length} layers · ${totalTokens} tokens`
    : undefined;

  return (
    <CardShell icon="◇" title="KG theme composition" subtitle={subtitle} status={props.status}>
      {compId && !composition && <MonoId value={compId} />}
      {isLoading && <Skeleton lines={6} />}
      {props.isError && <ErrorBox message={String(props.result ?? 'Composition fetch failed')} />}
      {!props.isError && !isLoading && composition && (
        <>
          <div className={styles.compHeader}>
            <div className={styles.compTitleRow}>
              <span className={styles.compName}>
                {composition.name || compId || 'Untitled composition'}
              </span>
              {composition.isActive === true && (
                <span className={styles.compActiveBadge}>Active</span>
              )}
              {composition.isActive === false && (
                <span className={styles.compInactiveBadge}>Inactive</span>
              )}
            </div>
            {composition.id && <MonoId value={composition.id} />}
            {composition.workspaceId && (
              <div className={styles.compMeta}>workspace: {composition.workspaceId}</div>
            )}
          </div>
          {layers.length === 0 && (
            <div className={styles.empty}>Composition has no theme layers.</div>
          )}
          {layers.map((layer, i) => {
            const themeName = layer.theme?.name ?? layer.theme?.slug ?? `Layer ${i + 1}`;
            const tokens = Array.isArray(layer.tokens) ? layer.tokens : [];
            return (
              <details key={layer.theme?.id ?? i} className={styles.layer} open={i === 0}>
                <summary className={styles.layerHead}>
                  <span className={styles.layerOrder}>#{layer.order ?? i}</span>
                  <span className={styles.layerName}>{themeName}</span>
                  {layer.theme?.kind && (
                    <span className={styles.layerKind}>{layer.theme.kind}</span>
                  )}
                  <span className={styles.layerTokenCount}>
                    {tokens.length} {tokens.length === 1 ? 'token' : 'tokens'}
                  </span>
                </summary>
                <div className={styles.layerBody}>
                  {tokens.length > 0 && (
                    <table className={styles.tokenTable}>
                      <tbody>
                        {tokens.map((tok, ti) => {
                          const swatch = colorSwatchValue(tok);
                          return (
                            <tr key={tok.id ?? ti}>
                              <td className={styles.tokenPath}>{tok.path ?? '—'}</td>
                              <td className={styles.tokenValue}>
                                {swatch && (
                                  <span
                                    className={styles.tokenSwatch}
                                    style={{ background: swatch }}
                                  />
                                )}
                                {tokenValueText(tok)}
                              </td>
                              {tok.targetType && (
                                <td className={styles.tokenType}>{String(tok.targetType)}</td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                  {tokens.length === 0 && (
                    <div className={styles.empty} style={{ padding: '8px 10px' }}>
                      No tokens in this layer.
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </>
      )}
      {parsed != null && !isLoading && <RawJsonAccordion data={parsed} />}
    </CardShell>
  );
}

/* ─── kg_neighbors (expand outward from one root node) ──────────────── */

export function KgNeighborsCard(props: ToolRenderProps) {
  const args = (props.args ?? {}) as {
    node_id?: string;
    depth?: number;
    direction?: string;
  };
  const rootId = String(args.node_id ?? '');
  const depth = typeof args.depth === 'number' ? args.depth : 1;
  const direction =
    typeof args.direction === 'string' && args.direction
      ? args.direction.toUpperCase()
      : 'BOTH';
  const parsed = tryParseJson(props.result);
  const graph = extractGraph(parsed);

  const nodeById = new Map<string, KgHit>();
  if (graph) {
    for (const n of graph.nodes) {
      const id = hitId(n);
      if (id) nodeById.set(id, n);
    }
  }
  const labelOf = (id: string | undefined): string => {
    if (!id) return '?';
    const n = nodeById.get(id);
    return n ? hitLabel(n) : id.slice(0, 8) + '…';
  };
  const isLoading = props.status === 'executing' || props.status === 'inProgress';
  const subtitle = `depth ${depth} · ${direction.toLowerCase()}`;

  return (
    <CardShell icon="⤬" title="KG neighbors" subtitle={subtitle} status={props.status}>
      {rootId && (
        <div className={styles.rootBox}>
          <span className={styles.rootLabel}>root</span>
          <div className={styles.rootName}>● {labelOf(rootId)}</div>
          <MonoId value={rootId} />
        </div>
      )}
      {isLoading && <Skeleton lines={4} />}
      {props.isError && <ErrorBox message={String(props.result ?? 'Neighbors failed')} />}
      {!props.isError && !isLoading && graph && (
        <>
          <div className={styles.counts}>
            {graph.nodes.length} nodes · {graph.edges.length} edges
          </div>
          {graph.edges.length > 0 && (
            <div className={styles.edgeList}>
              {graph.edges.map((e, i) => {
                const sourceId = edgeSourceId(e);
                const targetId = edgeTargetId(e);
                const isOutgoing = sourceId === rootId;
                const otherId = isOutgoing ? targetId : sourceId;
                const arrow = isOutgoing ? '──▶' : '◀──';
                const n = nodeById.get(otherId);
                const k = n ? hitKind(n) : undefined;
                return (
                  <div key={i} className={styles.edge}>
                    <span className={styles.edgeArrow}>
                      {arrow} {edgeRel(e)}
                    </span>
                    <span className={styles.edgeNode}>● {labelOf(otherId)}</span>
                    {k ? <span className={styles.edgeKind}>{k}</span> : <span />}
                  </div>
                );
              })}
            </div>
          )}
          {graph.edges.length === 0 && graph.nodes.length > 0 && (
            <div className={styles.empty}>
              {graph.nodes.length} nodes returned, no edges in response.
            </div>
          )}
        </>
      )}
      {parsed != null && !isLoading && <RawJsonAccordion data={parsed} />}
    </CardShell>
  );
}
