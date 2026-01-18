export const styles = `
:root {
  --bg-0: #ffffff;
  --bg-1: #fafafa;
  --bg-2: #f0f0f0;
  --bg-3: #e8e8e8;
  --text-0: #1a1a1a;
  --text-1: #444444;
  --text-2: #666666;
  --text-3: #888888;
  --border: #e0e0e0;
  --accent: #0066ff;
  --accent-light: #e6f0ff;
  --success: #00875a;
  --success-bg: #e6f4ef;
  --warning: #b86e00;
  --warning-bg: #fff4e6;
  --error: #de350b;
  --error-bg: #ffebe6;
  --info: #0066ff;
  --info-bg: #e6f0ff;
  --radius: 0;
  --shadow: 0 1px 3px rgba(0,0,0,0.08);
  --font-mono: 'SF Mono', 'Consolas', 'Monaco', monospace;
}

[data-theme="dark"] {
  --bg-0: #1a1a1a;
  --bg-1: #242424;
  --bg-2: #2e2e2e;
  --bg-3: #383838;
  --text-0: #f0f0f0;
  --text-1: #cccccc;
  --text-2: #999999;
  --text-3: #666666;
  --border: #404040;
  --accent: #4d94ff;
  --accent-light: #1a3a5c;
  --success: #36b37e;
  --success-bg: #1a3329;
  --warning: #ffab00;
  --warning-bg: #3d2e00;
  --error: #ff5630;
  --error-bg: #3d1a14;
  --info: #4d94ff;
  --info-bg: #1a3a5c;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg-0);
  color: var(--text-0);
}

.app {
  display: flex;
  min-height: 100vh;
}

/* Sidebar */
.sidebar {
  width: 220px;
  background: var(--bg-1);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-logo {
  font-weight: 600;
  font-size: 16px;
}

.sidebar-nav {
  flex: 1;
  padding: 8px;
  overflow-y: auto;
}

.nav-section {
  margin-bottom: 16px;
}

.nav-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 8px 12px 4px;
  letter-spacing: 0.5px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius);
  color: var(--text-1);
  text-decoration: none;
  cursor: pointer;
  transition: background 0.15s;
}

.nav-item:hover {
  background: var(--bg-2);
}

.nav-item.active {
  background: var(--accent-light);
  color: var(--accent);
}

.nav-icon {
  width: 18px;
  text-align: center;
}

/* Main content */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.header {
  height: 52px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: var(--bg-1);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

/* Page header */
.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 4px;
}

.page-desc {
  color: var(--text-2);
}

/* Cards */
.card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.card-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-title {
  font-weight: 600;
}

.card-body {
  padding: 16px;
}

.card-body-flush {
  padding: 0;
}

/* Grid */
.grid {
  display: grid;
  gap: 16px;
}

.grid-2 { grid-template-columns: repeat(2, 1fr); }
.grid-3 { grid-template-columns: repeat(3, 1fr); }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
.grid-5 { grid-template-columns: repeat(5, 1fr); }

/* Stats */
.stat-card {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
}

/* Badges */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 500;
}

.badge-neutral {
  background: var(--bg-3);
  color: var(--text-1);
}

.badge-success {
  background: var(--success-bg);
  color: var(--success);
}

.badge-warning {
  background: var(--warning-bg);
  color: var(--warning);
}

.badge-error {
  background: var(--error-bg);
  color: var(--error);
}

.badge-info {
  background: var(--info-bg);
  color: var(--info);
}

.badge-method {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 6px;
}

.badge-get { background: var(--success-bg); color: var(--success); }
.badge-post { background: var(--info-bg); color: var(--info); }
.badge-patch { background: var(--warning-bg); color: var(--warning); }
.badge-put { background: #f3e6ff; color: #7b2cbf; }
.badge-delete { background: var(--error-bg); color: var(--error); }

[data-theme="dark"] .badge-put { background: #2d1f3d; color: #b36bff; }

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
  text-decoration: none;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-secondary {
  background: var(--bg-2);
  color: var(--text-0);
  border: 1px solid var(--border);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-3);
}

.btn-ghost {
  background: transparent;
  color: var(--text-1);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-2);
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-icon {
  width: 32px;
  height: 32px;
  padding: 0;
}

/* Inputs */
.input {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 13px;
  background: var(--bg-0);
  color: var(--text-0);
  outline: none;
  transition: border-color 0.15s;
}

.input:focus {
  border-color: var(--accent);
}

.input-mono {
  font-family: var(--font-mono);
}

.select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L2 4h8z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 30px;
}

/* Tables */
.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.table th {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-2);
}

.table tbody tr:hover {
  background: var(--bg-2);
}

.table-mono td {
  font-family: var(--font-mono);
  font-size: 12px;
}

.table-sortable th {
  cursor: pointer;
  user-select: none;
}

.table-sortable th:hover {
  background: var(--bg-3);
}

/* Toolbar */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* List items */
.list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}

.list-item:last-child {
  border-bottom: none;
}

.list-item:hover {
  background: var(--bg-2);
}

/* Empty state */
.empty-state {
  padding: 40px;
  text-align: center;
  color: var(--text-2);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.empty-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--text-1);
}

.empty-desc {
  font-size: 13px;
}

/* Code */
.code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-2);
  padding: 12px;
  border-radius: var(--radius);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.code-inline {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-2);
  padding: 2px 6px;
  border-radius: var(--radius);
}

/* Alerts */
.alert {
  padding: 12px 16px;
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  gap: 8px;
}

.alert-warning {
  background: var(--warning-bg);
  color: var(--warning);
}

.alert-error {
  background: var(--error-bg);
  color: var(--error);
}

.alert-info {
  background: var(--info-bg);
  color: var(--info);
}

.alert-success {
  background: var(--success-bg);
  color: var(--success);
}

/* Environment badges */
.env-badge {
  padding: 4px 10px;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.env-dev {
  background: var(--success-bg);
  color: var(--success);
}

.env-staging {
  background: var(--warning-bg);
  color: var(--warning);
}

.env-prod {
  background: var(--info-bg);
  color: var(--info);
}

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-0);
  border-radius: var(--radius);
  box-shadow: 0 4px 20px rgba(0,0,0,0.2);
  min-width: 400px;
  max-width: 90vw;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-header {
  padding: 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-title {
  font-weight: 600;
  font-size: 16px;
}

.modal-body {
  padding: 16px;
  overflow-y: auto;
}

.modal-footer {
  padding: 16px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Form */
.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
}

.form-input {
  width: 100%;
}

/* Toast notifications */
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast {
  padding: 12px 16px;
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  animation: slideIn 0.2s ease;
}

.toast-success {
  background: var(--success);
  color: white;
}

.toast-error {
  background: var(--error);
  color: white;
}

@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

/* Loading */
.loading {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* HTMX loading indicator */
.htmx-request .htmx-indicator {
  display: inline-block;
}

.htmx-indicator {
  display: none;
}

/* Responsive */
@media (max-width: 768px) {
  .sidebar {
    display: none;
  }

  .grid-4, .grid-3 {
    grid-template-columns: repeat(2, 1fr);
  }
}
`;
