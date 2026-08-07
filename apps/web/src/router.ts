// Tiny URL router. We avoid pulling in react-router for two reasons:
// the surface area we need is small (three routes, plain pushState), and
// we want a single source of truth for "what file is open" — encoding
// that in the URL is the simplest way to make it deep-linkable.

import { useEffect, useState } from 'react';

// Entry-shell sub-views. The home/project landing renders one of three
// columns and each sub-view now owns a top-level path so the browser
// back/forward buttons work, deep links are shareable, and per-tab
// state isn't trapped behind a `useState` boundary.
export type EntryHomeView =
  | 'home'
  | 'onboarding'
  | 'projects'
  | 'tasks'
  | 'pipelines'
  | 'plugins'
  | 'design-systems'
  | 'integrations';

export type Route =
  | { kind: 'home'; view: EntryHomeView }
  | { kind: 'design-system-create' }
  | { kind: 'design-system-detail'; designSystemId: string }
  | {
      kind: 'project';
      projectId: string;
      /**
       * Deep-link to a specific conversation inside the project. When
       * present, the project view picks this conversation as the active
       * one instead of defaulting to `list[0]`. Falls back to the
       * default picker when the routed conversation no longer exists.
       * Added for issue #1505 (Routines history → specific conversation).
       */
      conversationId?: string | null;
      fileName: string | null;
    }
  | { kind: 'marketplace' }
  | { kind: 'marketplace-detail'; pluginId: string }
  // Full-page "Quick result" for a pipeline stage. Replaces the old xl modal
  // so a finished stage's output preview gets the whole viewport. Rendered by
  // PipelinesView (which owns the loaded pipeline list) under the pipelines shell.
  | { kind: 'pipeline-result'; projectId: string; pipelineId: string }
  // Pipelines drill-down: App → Feature → Pipeline → Chạy. Mỗi cấp một màn,
  // một việc. Cấp đang xem sống trong URL (không phải useState) nên F5 không
  // mất chỗ và link dán được cho đồng nghiệp.
  //
  // Segment literal `app/` tách hẳn nhánh này khỏi route Quick result cũ
  // (`/pipelines/:projectId/result/:pipelineId`) — thông báo và link cũ vẫn
  // phải mở được, nên nhánh đó được kiểm TRƯỚC trong parseRoute.
  | { kind: 'pipelines-app'; appId: string }
  | { kind: 'pipelines-feature'; appId: string; featureId: string }
  | { kind: 'pipelines-run'; appId: string; featureId: string; pipelineId: string };

/** Rổ chứa feature chưa gắn app nào (mirror pipeline-studio's bucket id). */
export const UNASSIGNED_APP = '__unassigned';

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home', view: 'home' };
  if (parts[0] === 'onboarding') {
    return { kind: 'home', view: 'onboarding' };
  }
  if (parts[0] === 'projects') {
    if (parts[1]) {
      const projectId = decodeURIComponent(parts[1]);
      // /projects/:id/conversations/:cid[/files/...]
      if (parts[2] === 'conversations' && parts[3]) {
        const conversationId = decodeURIComponent(parts[3]);
        if (parts[4] === 'files' && parts[5]) {
          return {
            kind: 'project',
            projectId,
            conversationId,
            fileName: decodeURIComponent(parts.slice(5).join('/')),
          };
        }
        return { kind: 'project', projectId, conversationId, fileName: null };
      }
      // /projects/:id/files/...
      if (parts[2] === 'files' && parts[3]) {
        return {
          kind: 'project',
          projectId,
          conversationId: null,
          fileName: decodeURIComponent(parts.slice(3).join('/')),
        };
      }
      return { kind: 'project', projectId, conversationId: null, fileName: null };
    }
    return { kind: 'home', view: 'projects' };
  }
  if (parts[0] === 'design-systems') {
    if (parts[1] === 'create') {
      return { kind: 'design-system-create' };
    }
    if (parts[1]) {
      return { kind: 'design-system-detail', designSystemId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'design-systems' };
  }
  if (parts[0] === 'automations' || parts[0] === 'tasks') {
    return { kind: 'home', view: 'tasks' };
  }
  if (parts[0] === 'pipelines') {
    // /pipelines/:projectId/result/:pipelineId → full-page Quick result.
    // Kiểm TRƯỚC nhánh drill-down: link cũ trong thông báo phải mở được, kể cả
    // khi một dự án tình cờ tên là "app".
    if (parts[1] && parts[2] === 'result' && parts[3]) {
      return {
        kind: 'pipeline-result',
        projectId: decodeURIComponent(parts[1]),
        pipelineId: decodeURIComponent(parts[3]),
      };
    }
    // /pipelines/app/:appId[/:featureId[/:pipelineId]] → drill-down.
    if (parts[1] === 'app' && parts[2]) {
      const appId = decodeURIComponent(parts[2]);
      if (parts[3]) {
        const featureId = decodeURIComponent(parts[3]);
        if (parts[4]) {
          return {
            kind: 'pipelines-run',
            appId,
            featureId,
            pipelineId: decodeURIComponent(parts[4]),
          };
        }
        return { kind: 'pipelines-feature', appId, featureId };
      }
      return { kind: 'pipelines-app', appId };
    }
    return { kind: 'home', view: 'pipelines' };
  }
  if (parts[0] === 'plugins' && !parts[1]) {
    return { kind: 'home', view: 'plugins' };
  }
  if (parts[0] === 'integrations') {
    return { kind: 'home', view: 'integrations' };
  }
  // Phase 2B / spec §11.6 — marketplace deep UI routes. Two paths:
  //   /marketplace            → catalog grid (MarketplaceView)
  //   /marketplace/<pluginId> → detail page (PluginDetailView)
  // Aliases to /plugins remain reserved for the public site (spec §13);
  // in-app we keep /marketplace canonical.
  if (parts[0] === 'marketplace' || parts[0] === 'plugins') {
    if (parts[1]) {
      return { kind: 'marketplace-detail', pluginId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'marketplace' };
  }
  return { kind: 'home', view: 'home' };
}

export function buildPath(route: Route): string {
  if (route.kind === 'home') {
    if (route.view === 'onboarding') return '/onboarding';
    if (route.view === 'projects') return '/projects';
    if (route.view === 'tasks') return '/automations';
    if (route.view === 'pipelines') return '/pipelines';
    if (route.view === 'plugins') return '/plugins';
    if (route.view === 'design-systems') return '/design-systems';
    if (route.view === 'integrations') return '/integrations';
    return '/';
  }
  if (route.kind === 'pipeline-result') {
    return `/pipelines/${encodeURIComponent(route.projectId)}/result/${encodeURIComponent(route.pipelineId)}`;
  }
  if (route.kind === 'pipelines-app') {
    return `/pipelines/app/${encodeURIComponent(route.appId)}`;
  }
  if (route.kind === 'pipelines-feature') {
    return `/pipelines/app/${encodeURIComponent(route.appId)}/${encodeURIComponent(route.featureId)}`;
  }
  if (route.kind === 'pipelines-run') {
    return (
      `/pipelines/app/${encodeURIComponent(route.appId)}` +
      `/${encodeURIComponent(route.featureId)}/${encodeURIComponent(route.pipelineId)}`
    );
  }
  if (route.kind === 'marketplace') return '/marketplace';
  if (route.kind === 'marketplace-detail') return `/marketplace/${encodeURIComponent(route.pluginId)}`;
  if (route.kind === 'design-system-create') return '/design-systems/create';
  if (route.kind === 'design-system-detail') {
    return `/design-systems/${encodeURIComponent(route.designSystemId)}`;
  }
  const id = encodeURIComponent(route.projectId);
  const file = route.fileName
    ? route.fileName.split('/').map((s) => encodeURIComponent(s)).join('/')
    : null;
  if (route.conversationId) {
    const cid = encodeURIComponent(route.conversationId);
    return file
      ? `/projects/${id}/conversations/${cid}/files/${file}`
      : `/projects/${id}/conversations/${cid}`;
  }
  return file ? `/projects/${id}/files/${file}` : `/projects/${id}`;
}

// Centralized navigation. Components call this instead of mutating
// `window.location` directly so we can fan the change out to any
// `useRoute()` subscriber via a custom event.
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const target = buildPath(route);
  const current = window.location.pathname;
  if (target === current) return;
  if (opts.replace) {
    window.history.replaceState(null, '', target);
  } else {
    window.history.pushState(null, '', target);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
