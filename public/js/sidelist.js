import { h } from './dom.js';

// Kateqoriya qrupları: başlığa basanda bağlanır/açılır. Bağlı qruplar brauzerdə yadda qalır.
export function collapsible(storeKey) {
  const load = () => {
    try { return new Set(JSON.parse(localStorage.getItem(storeKey) || '[]')); } catch { return new Set(); }
  };
  const closed = load();
  const save = () => { try { localStorage.setItem(storeKey, JSON.stringify([...closed])); } catch { /* yadda saxlamaq mümkün deyil */ } };
  return {
    // Axtarış zamanı tapılan qruplar həmişə açıq görünür.
    isOpen: (g, searching) => searching || !closed.has(g),
    header(g, count, searching, redraw) {
      const open = searching || !closed.has(g);
      const toggle = () => {
        if (searching) return;
        if (closed.has(g)) closed.delete(g); else closed.add(g);
        save();
        redraw();
      };
      return h('div', { class: 'grp tog', role: 'button', tabindex: '0', 'aria-expanded': String(open), onclick: toggle,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
      h('span', { class: 'arr', 'aria-hidden': 'true' }, open ? '▾' : '▸'), g.toUpperCase(), h('span', { class: 'cnt' }, count));
    },
  };
}
