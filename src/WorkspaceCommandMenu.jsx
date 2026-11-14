import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Command, FileText, Search, X } from 'lucide-react';

// This component only navigates to the same role-filtered pages as the
// sidebar. It never creates an order, updates stock, or modifies a POS ledger.
export default function WorkspaceCommandMenu({ allowed, onNavigate, onSearchProducts, onClose }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef(null);
  const dialog = useRef(null);
  const choices = useMemo(() => {
    const actions = [
      { id:'search-products', label:'Search product catalogue', short:'Products', group:'Quick actions',
        icon:Search, action:onSearchProducts },
      ...allowed.map(item => ({ ...item, action:() => onNavigate(item.id) })),
    ];
    const needle = query.trim().toLocaleLowerCase();
    return needle ? actions.filter(item =>
      (item.label + ' ' + item.group + ' ' + item.short).toLocaleLowerCase().includes(needle)) : actions;
  }, [allowed, query, onNavigate, onSearchProducts]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setSelected(0); }, [query]);

  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'ArrowDown') {
      event.preventDefault(); setSelected(index => Math.min(index + 1, choices.length - 1));
    }
    if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(index => Math.max(0, index - 1)); }
    if (event.key === 'Enter' && choices[selected]) {
      event.preventDefault(); choices[selected].action(); onClose();
    }
    if (event.key === 'Tab') {
      const controls = Array.from(dialog.current?.querySelectorAll('input:not(:disabled),button:not(:disabled)') || []);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  return <div className="workspace-command-overlay" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialog} className="workspace-command-dialog" role="dialog" aria-modal="true"
      aria-label="Find a page" onKeyDown={onKeyDown}>
      <div className="workspace-command-search">
        <Search size={19} aria-hidden="true"/>
        <input ref={input} type="search" aria-label="Search pages and actions"
          placeholder="Search pages, products and actions…"
          value={query} onChange={event => setQuery(event.target.value)}/>
        <button className="workspace-command-close" type="button" aria-label="Close page switcher" onClick={onClose}>
          <X size={17}/>
        </button>
      </div>
      <div className="workspace-command-content" role="listbox" aria-label="Workspace pages">
        <span className="workspace-command-caption">{query ? 'Matching pages' : 'Quickly switch to…'}</span>
        {choices.length ? choices.map((item,index) => {
          const Icon = item.icon || FileText;
          return <button type="button" role="option" key={item.id}
            aria-selected={index === selected}
            className={'workspace-command-result' + (index === selected ? ' active' : '')}
            onMouseEnter={() => setSelected(index)} onClick={() => { item.action(); onClose(); }}>
            <span className="command-icon"><Icon size={17} aria-hidden="true"/></span>
            <span>{item.label}</span><small>{item.group}</small><ArrowRight size={15} aria-hidden="true"/>
          </button>;
        }) : <p className="workspace-command-empty">No matching pages in your workspace.</p>}
      </div>
      <div className="workspace-command-footer"><span><kbd>↑</kbd><kbd>↓</kbd>Navigate</span>
        <span><kbd>Enter</kbd>Open</span><span><kbd>Esc</kbd>Close</span>
        <Command size={14} aria-hidden="true"/>
      </div>
    </section>
  </div>;
}
