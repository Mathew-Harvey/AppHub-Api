import { useState, useEffect } from "react";

const data = {
  stats: [
    { label: "Revenue", value: "$84,210", delta: "+12.4%", up: true },
    { label: "Active Users", value: "3,847", delta: "+5.1%", up: true },
    { label: "Churn Rate", value: "2.3%", delta: "-0.4%", up: false },
    { label: "Avg. Session", value: "4m 12s", delta: "+0.8%", up: true },
  ],
  chart: [42, 67, 55, 80, 73, 90, 61, 88, 95, 70, 83, 100],
  months: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
  recent: [
    { id: "#4821", user: "Mira Okonkwo", plan: "Pro", amount: "$149", status: "paid" },
    { id: "#4820", user: "Tariq Mossad", plan: "Starter", amount: "$29", status: "paid" },
    { id: "#4819", user: "Sven Larssen", plan: "Enterprise", amount: "$899", status: "pending" },
    { id: "#4818", user: "Yuki Tanaka", plan: "Pro", amount: "$149", status: "paid" },
    { id: "#4817", user: "Camille Renard", plan: "Starter", amount: "$29", status: "failed" },
  ],
  activity: [
    { time: "2m ago", text: "New signup — Mira Okonkwo" },
    { time: "14m ago", text: "Payment failed — Camille Renard" },
    { time: "1h ago", text: "Plan upgrade — Sven Larssen → Enterprise" },
    { time: "3h ago", text: "API threshold reached — Workspace #22" },
    { time: "5h ago", text: "Export completed — Q4 report" },
  ],
};

const statusColor = { paid: "#22c55e", pending: "#f59e0b", failed: "#ef4444" };

export default function Dashboard() {
  const [tick, setTick] = useState(0);
  const [hoveredBar, setHoveredBar] = useState(null);
  const maxVal = Math.max(...data.chart);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  const liveValue = (3847 + tick * 3).toLocaleString();

  return (
    <div style={styles.root}>
      {/* Noise overlay */}
      <div style={styles.noise} />

      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <span style={styles.logoMark}>◈</span>
          <span style={styles.logoText}>STRATA</span>
        </div>
        <nav style={styles.nav}>
          {[
            ["◉", "Overview"],
            ["◈", "Analytics"],
            ["⬡", "Customers"],
            ["⬟", "Billing"],
            ["◎", "Settings"],
          ].map(([icon, label], i) => (
            <div key={label} style={{ ...styles.navItem, ...(i === 0 ? styles.navActive : {}) }}>
              <span style={styles.navIcon}>{icon}</span>
              <span>{label}</span>
            </div>
          ))}
        </nav>
        <div style={styles.sidebarFooter}>
          <div style={styles.avatar}>JS</div>
          <div>
            <div style={styles.userName}>Jordan Steele</div>
            <div style={styles.userRole}>Admin</div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main style={styles.main}>
        {/* Header */}
        <header style={styles.header}>
          <div>
            <div style={styles.pageTitle}>Overview</div>
            <div style={styles.pageSubtitle}>Last updated just now</div>
          </div>
          <div style={styles.headerRight}>
            <div style={styles.liveChip}>
              <span style={{ ...styles.liveDot, opacity: tick % 2 === 0 ? 1 : 0.3 }} />
              LIVE
            </div>
            <button style={styles.btn}>Export</button>
          </div>
        </header>

        {/* Stat Cards */}
        <div style={styles.statsGrid}>
          {data.stats.map((s, i) => (
            <div key={s.label} style={styles.card}>
              <div style={styles.cardLabel}>{s.label}</div>
              <div style={styles.cardValue}>
                {i === 1 ? liveValue : s.value}
              </div>
              <div style={{ ...styles.cardDelta, color: s.up ? "#22c55e" : "#ef4444" }}>
                {s.up ? "▲" : "▼"} {s.delta}
              </div>
              <div style={styles.cardBar}>
                <div style={{ ...styles.cardBarFill, width: `${[72, 60, 30, 55][i]}%`, opacity: 0.18 + i * 0.04 }} />
              </div>
            </div>
          ))}
        </div>

        {/* Chart + Activity */}
        <div style={styles.midRow}>
          {/* Bar Chart */}
          <div style={{ ...styles.card, flex: 2 }}>
            <div style={styles.cardHeader}>
              <span style={styles.cardTitle}>Monthly Revenue</span>
              <span style={styles.cardTag}>2025</span>
            </div>
            <div style={styles.chartArea}>
              {data.chart.map((v, i) => (
                <div key={i} style={styles.barCol}
                  onMouseEnter={() => setHoveredBar(i)}
                  onMouseLeave={() => setHoveredBar(null)}>
                  {hoveredBar === i && (
                    <div style={styles.tooltip}>${(v * 842).toLocaleString()}</div>
                  )}
                  <div
                    style={{
                      ...styles.bar,
                      height: `${(v / maxVal) * 100}%`,
                      background: hoveredBar === i
                        ? "var(--accent)"
                        : `rgba(245,158,11,${0.25 + (v / maxVal) * 0.5})`,
                    }}
                  />
                  <div style={styles.barLabel}>{data.months[i]}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Activity Feed */}
          <div style={{ ...styles.card, flex: 1 }}>
            <div style={styles.cardHeader}>
              <span style={styles.cardTitle}>Activity</span>
            </div>
            <div style={styles.feedList}>
              {data.activity.map((item, i) => (
                <div key={i} style={styles.feedItem}>
                  <div style={styles.feedLine} />
                  <div>
                    <div style={styles.feedText}>{item.text}</div>
                    <div style={styles.feedTime}>{item.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Transactions */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>Recent Transactions</span>
            <span style={{ ...styles.cardTag, cursor: "pointer" }}>View all →</span>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                {["ID", "Customer", "Plan", "Amount", "Status"].map(h => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recent.map((row, i) => (
                <tr key={row.id} style={{ ...styles.tr, ...(i % 2 === 0 ? styles.trAlt : {}) }}>
                  <td style={styles.td}><span style={styles.idBadge}>{row.id}</span></td>
                  <td style={styles.td}>{row.user}</td>
                  <td style={styles.td}>{row.plan}</td>
                  <td style={{ ...styles.td, fontVariantNumeric: "tabular-nums" }}>{row.amount}</td>
                  <td style={styles.td}>
                    <span style={{ ...styles.statusBadge, color: statusColor[row.status], borderColor: statusColor[row.status] + "44", background: statusColor[row.status] + "11" }}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

const styles = {
  root: {
    display: "flex",
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#e8e3d8",
    fontFamily: "'DM Mono', 'Courier New', monospace",
    position: "relative",
    "--accent": "#f59e0b",
  },
  noise: {
    position: "fixed", inset: 0, zIndex: 0,
    backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E\")",
    backgroundRepeat: "repeat", backgroundSize: "200px 200px",
    pointerEvents: "none", opacity: 0.5,
  },
  sidebar: {
    width: 220, background: "#111", borderRight: "1px solid #222",
    display: "flex", flexDirection: "column", padding: "28px 0",
    position: "sticky", top: 0, height: "100vh", zIndex: 10,
    flexShrink: 0,
  },
  logo: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "0 24px 28px", borderBottom: "1px solid #222", marginBottom: 20,
  },
  logoMark: { fontSize: 20, color: "#f59e0b" },
  logoText: { fontSize: 15, fontWeight: 700, letterSpacing: "0.15em", color: "#fff" },
  nav: { flex: 1, padding: "0 12px", display: "flex", flexDirection: "column", gap: 2 },
  navItem: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "9px 12px", borderRadius: 6, cursor: "pointer",
    fontSize: 13, color: "#777", letterSpacing: "0.04em",
    transition: "all 0.15s",
  },
  navActive: { background: "#1a1a1a", color: "#e8e3d8", borderLeft: "2px solid #f59e0b", paddingLeft: 10 },
  navIcon: { fontSize: 14, width: 18, textAlign: "center" },
  sidebarFooter: {
    borderTop: "1px solid #222", padding: "18px 24px",
    display: "flex", alignItems: "center", gap: 10,
  },
  avatar: {
    width: 32, height: 32, borderRadius: "50%",
    background: "#f59e0b22", color: "#f59e0b", fontSize: 11,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontWeight: 700, border: "1px solid #f59e0b44",
  },
  userName: { fontSize: 12, color: "#e8e3d8", fontWeight: 600 },
  userRole: { fontSize: 11, color: "#555" },
  main: { flex: 1, padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20, position: "relative", zIndex: 1, overflowX: "hidden" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  pageTitle: { fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em" },
  pageSubtitle: { fontSize: 12, color: "#555", marginTop: 3 },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  liveChip: {
    display: "flex", alignItems: "center", gap: 6,
    fontSize: 11, letterSpacing: "0.12em", color: "#f59e0b",
    background: "#f59e0b11", border: "1px solid #f59e0b33",
    padding: "5px 10px", borderRadius: 4,
  },
  liveDot: { width: 6, height: 6, borderRadius: "50%", background: "#f59e0b", transition: "opacity 0.3s" },
  btn: {
    background: "transparent", border: "1px solid #333", color: "#aaa",
    padding: "7px 16px", borderRadius: 6, fontSize: 12, cursor: "pointer",
    letterSpacing: "0.05em",
  },
  statsGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 },
  card: {
    background: "#111", border: "1px solid #1e1e1e", borderRadius: 10,
    padding: 20, position: "relative", overflow: "hidden",
  },
  cardLabel: { fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 },
  cardValue: { fontSize: 26, fontWeight: 700, color: "#fff", letterSpacing: "-0.03em" },
  cardDelta: { fontSize: 12, marginTop: 4 },
  cardBar: { position: "absolute", bottom: 0, left: 0, right: 0, height: 3, background: "#1a1a1a" },
  cardBarFill: { height: "100%", background: "#f59e0b", borderRadius: 2 },
  midRow: { display: "flex", gap: 16 },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  cardTitle: { fontSize: 13, fontWeight: 600, color: "#ccc", letterSpacing: "0.04em" },
  cardTag: { fontSize: 11, color: "#555", background: "#1a1a1a", padding: "3px 8px", borderRadius: 4 },
  chartArea: {
    display: "flex", alignItems: "flex-end", gap: 6,
    height: 160, paddingBottom: 22,
  },
  barCol: {
    flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "flex-end", height: "100%", cursor: "pointer", position: "relative",
  },
  bar: { width: "100%", borderRadius: "3px 3px 0 0", transition: "background 0.15s, height 0.3s" },
  barLabel: { position: "absolute", bottom: 0, fontSize: 9, color: "#444", letterSpacing: "0.04em" },
  tooltip: {
    position: "absolute", top: -28, background: "#f59e0b", color: "#000",
    fontSize: 10, padding: "3px 6px", borderRadius: 4, fontWeight: 700,
    whiteSpace: "nowrap", pointerEvents: "none",
  },
  feedList: { display: "flex", flexDirection: "column", gap: 14 },
  feedItem: { display: "flex", gap: 12, alignItems: "flex-start" },
  feedLine: { width: 2, flexShrink: 0, marginTop: 5, height: 28, background: "#1e1e1e", borderRadius: 2 },
  feedText: { fontSize: 12, color: "#bbb", lineHeight: 1.4 },
  feedTime: { fontSize: 10, color: "#444", marginTop: 3 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { fontSize: 10, color: "#444", letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "left", padding: "8px 12px", borderBottom: "1px solid #1e1e1e" },
  tr: { transition: "background 0.1s" },
  trAlt: { background: "#0d0d0d" },
  td: { fontSize: 12, color: "#bbb", padding: "11px 12px" },
  idBadge: { color: "#f59e0b", fontFamily: "monospace", fontSize: 11 },
  statusBadge: {
    fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
    padding: "3px 8px", borderRadius: 4, border: "1px solid",
  },
};