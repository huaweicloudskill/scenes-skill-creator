/**
 * Client half of scenes-skill-creator.
 *
 * The panel UI is the v33 prototype (assets/panel.html) served by the Host at
 * `/scenes-skill-creator/app/` and mounted in an iframe that fills the main slot.
 * The prototype is not re-implemented here: keeping one HTML file is what makes the
 * panel identical to the design prototype. `assets/panel-bridge.js` maps the
 * prototype's simulated run state onto the Host API (create -> evaluate -> records).
 *
 * Surface: one id addresses the sidebar icon and the central page. The conversation
 * composer dock is deliberately not used (same decision as the reference plugin).
 */
window.__ModuleLoader__.load({
  id: '@huaweicloud-plugins/scenes-skill-creator',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'skill-creator';
    const APP_URL = '/scenes-skill-creator/app/';

    function parentTheme() {
      try {
        const explicit = document.documentElement.dataset.theme;
        if (explicit === 'light' || explicit === 'dark') return explicit;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch { return 'light'; }
    }

    function Panel() {
      const ref = React.useRef(null);
      const [src] = React.useState(() => `${APP_URL}?embed=1&theme=${parentTheme()}`);

      // The iframe carries the prototype's own theme switcher; sync later Host changes
      // through postMessage so a theme toggle outside the panel does not leave it stale.
      React.useEffect(() => {
        let last = parentTheme();
        const observer = new MutationObserver(() => {
          const next = parentTheme();
          if (next === last) return;
          last = next;
          try {
            if (ref.current && ref.current.contentWindow) {
              ref.current.contentWindow.postMessage({ type: 'sc-theme', theme: next }, '*');
            }
          } catch { /* ignore */ }
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
        return () => observer.disconnect();
      }, []);

      return h('div', { style: { width: '100%', height: '100%', minHeight: '70vh', display: 'flex' } },
        h('iframe', {
          ref,
          src,
          title: 'Scenes Skill Creator',
          'data-panel': 'scenes-skill-creator',
          style: { border: 0, width: '100%', height: '100%', minHeight: '70vh', display: 'block', background: 'transparent' },
          allow: 'clipboard-write',
        }));
    }

    function SkillCreatorIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', { d: 'M9.2 1.4 3.6 8.6h3.5l-.5 6 5.6-7.2H8.7z', fill: 'currentColor' }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'Scenes Skill Creator',
        }, SkillCreatorIcon));
      },
    };
  },
});