import { html, escapeHtml } from '../utils';
import { card, badge, emptyState } from '../components';

export interface ResourceInfo {
  name: string;
  fields: string[];
  capabilities: {
    enableCreate?: boolean;
    enableUpdate?: boolean;
    enableDelete?: boolean;
    enableSubscriptions?: boolean;
    enableAggregations?: boolean;
  };
  auth?: {
    public?: { read?: boolean; subscribe?: boolean };
    hasReadScope?: boolean;
    hasCreateScope?: boolean;
    hasUpdateScope?: boolean;
    hasDeleteScope?: boolean;
  };
  procedures?: string[];
}

export interface ResourcesPageData {
  resources: ResourceInfo[];
}

const hasNoAuthConfig = (auth: ResourceInfo['auth']): boolean => {
  if (!auth) return true;
  // Check if any auth property is set
  return !(
    auth.public?.read ||
    auth.public?.subscribe ||
    auth.hasReadScope ||
    auth.hasCreateScope ||
    auth.hasUpdateScope ||
    auth.hasDeleteScope
  );
};

export const resourcesPage = (data: ResourcesPageData): string => html`
  <div class="page-header">
    <h1 class="page-title">Resources</h1>
    <p class="page-desc">Registered API resources and their configurations</p>
  </div>

  ${data.resources.length > 0 ? html`
    <div style="display: flex; flex-direction: column; gap: 16px;">
      ${data.resources.map(resource => resourceCard(resource)).join('')}
    </div>
  ` : emptyState('\u25A3', 'No resources registered', 'Use useResource() to add resources')}
`;

const resourceCard = (resource: ResourceInfo): string => {
  const caps = resource.capabilities || {};

  return card({
    title: resource.name,
    headerRight: html`
      <div style="display: flex; gap: 4px;">
        ${caps.enableCreate ? badge('C', 'success') : ''}
        ${caps.enableUpdate ? badge('U', 'info') : ''}
        ${caps.enableDelete ? badge('D', 'error') : ''}
        ${caps.enableSubscriptions ? badge('SSE', 'info') : ''}
      </div>
    `,
  }, html`
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div>
        <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Fields (${resource.fields.length})</h4>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
          ${resource.fields.map(f => html`<span class="code-inline">${escapeHtml(f)}</span>`).join('')}
        </div>
      </div>

      <div>
        <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Auth</h4>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
          ${resource.auth?.public?.read ? badge('Public Read', 'success') : ''}
          ${resource.auth?.public?.subscribe ? badge('Public Subscribe', 'success') : ''}
          ${resource.auth?.hasReadScope ? badge('Read Scope', 'info') : ''}
          ${resource.auth?.hasCreateScope ? badge('Create Scope', 'info') : ''}
          ${resource.auth?.hasUpdateScope ? badge('Update Scope', 'info') : ''}
          ${resource.auth?.hasDeleteScope ? badge('Delete Scope', 'info') : ''}
          ${hasNoAuthConfig(resource.auth) ? badge('No Auth', 'warning') : ''}
        </div>
      </div>
    </div>

    ${resource.procedures && resource.procedures.length > 0 ? html`
      <div style="margin-top: 16px;">
        <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Procedures</h4>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
          ${resource.procedures.map(p => html`<span class="code-inline">${escapeHtml(p)}</span>`).join('')}
        </div>
      </div>
    ` : ''}

    <div style="margin-top: 16px;">
      <h4 style="font-size: 12px; color: var(--text-2); margin-bottom: 8px;">Endpoints</h4>
      <table class="table table-mono" style="font-size: 11px;">
        <tbody>
          <tr><td style="width: 80px;">${badge('GET', 'success')}</td><td>${escapeHtml(resource.name)}</td><td style="color: var(--text-2);">List</td></tr>
          <tr><td>${badge('GET', 'success')}</td><td>${escapeHtml(resource.name)}/:id</td><td style="color: var(--text-2);">Get</td></tr>
          ${caps.enableCreate ? html`<tr><td>${badge('POST', 'info')}</td><td>${escapeHtml(resource.name)}</td><td style="color: var(--text-2);">Create</td></tr>` : ''}
          ${caps.enableUpdate ? html`<tr><td>${badge('PATCH', 'warning')}</td><td>${escapeHtml(resource.name)}/:id</td><td style="color: var(--text-2);">Update</td></tr>` : ''}
          ${caps.enableDelete ? html`<tr><td>${badge('DELETE', 'error')}</td><td>${escapeHtml(resource.name)}/:id</td><td style="color: var(--text-2);">Delete</td></tr>` : ''}
          ${caps.enableSubscriptions ? html`<tr><td>${badge('GET', 'success')}</td><td>${escapeHtml(resource.name)}/subscribe</td><td style="color: var(--text-2);">SSE</td></tr>` : ''}
        </tbody>
      </table>
    </div>
  `);
};
