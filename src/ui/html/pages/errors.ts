import { html, escapeHtml, formatRelativeTime } from '../utils';
import { card, badge, statusBadge, emptyState } from '../components';

export interface ErrorInfo {
  id: string;
  status: number;
  path: string;
  message: string;
  stack?: string;
  timestamp: string;
}

export interface ErrorsPageData {
  errors: ErrorInfo[];
}

export const errorsPage = (data: ErrorsPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Errors</h1>
    <p class="page-desc">Recent API errors and their details</p>
  </div>

  ${card({
    title: 'Error Log',
    headerRight: badge(data.errors.length + ' errors', data.errors.length > 0 ? 'error' : 'neutral'),
    flush: true,
  }, html`
    ${data.errors.length > 0 ? html`
      <div style="max-height: 600px; overflow-y: auto;">
        ${data.errors.map(err => html`
          <div class="list-item" style="flex-direction: column; align-items: flex-start; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px; width: 100%;">
              ${statusBadge(err.status)}
              <span class="code-inline" style="flex: 1;">${escapeHtml(err.path)}</span>
              <span style="color: var(--text-3); font-size: 12px;">${formatRelativeTime(err.timestamp)}</span>
            </div>
            <div style="color: var(--error); font-size: 13px;">${escapeHtml(err.message)}</div>
            ${err.stack ? html`
              <details style="width: 100%;">
                <summary style="cursor: pointer; color: var(--text-2); font-size: 12px;">Stack trace</summary>
                <div class="code" style="margin-top: 8px; font-size: 11px; max-height: 200px; overflow-y: auto;">
                  ${escapeHtml(err.stack)}
                </div>
              </details>
            ` : ''}
          </div>
        `).join('')}
      </div>
    ` : emptyState('\u2713', 'No errors', 'All API requests completed successfully')}
  `)}
`;
