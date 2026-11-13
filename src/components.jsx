import React, { useEffect, useId, useRef } from 'react';
import { X, LoaderCircle, Check, AlertCircle, ShoppingBag, Shirt, Banknote, Smartphone, CreditCard, SearchX } from 'lucide-react';
import { money, methodLabel, statusLabel } from './api.js';

export function IconButton({ icon: Icon, label, className = '', ...props }) { return <button className={`icon-button ${className}`} title={label} aria-label={label} {...props}><Icon size={19} strokeWidth={1.8} /></button>; }
export function SellingModeSwitch({ mode, onRetail, onWholesale, canWholesale = true }) { return <div className="selling-mode-row"><div><span className="eyebrow">Selling mode</span><p>{mode === 'retail' ? 'Website retail prices · walk-in checkout' : 'Agreed wholesale prices · manager approval'}</p></div><div className="selling-mode" role="group" aria-label="Selling mode"><button type="button" aria-pressed={mode === 'retail'} className={mode === 'retail' ? 'selected' : ''} onClick={onRetail}>RETAIL</button><button type="button" aria-pressed={mode === 'wholesale'} className={mode === 'wholesale' ? 'selected' : ''} disabled={!canWholesale} title={!canWholesale ? 'Manager or owner access required' : undefined} onClick={onWholesale}>WHOLESALE</button></div></div>; }
export function Badge({ children, tone = 'neutral', dot = false }) { return <span className={`badge ${tone}`}>{dot && <span className="status-dot" />}{children}</span>; }
export function Empty({ icon: Icon = ShoppingBag, title, children, action }) { return <div className="empty-state"><div className="empty-icon"><Icon size={30} strokeWidth={1.4} /></div><h3>{title}</h3><p>{children}</p>{action}</div>; }
export function Spinner({ label = 'Loading…' }) { return <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>{label}</span></div>; }
export function ProductImage({ src, name, className = '' }) { return <div className={`product-image ${className}`}>{src ? <img src={src} alt={name} loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} /> : null}<Shirt className="image-fallback" size={44} strokeWidth={1} /></div>; }
export function PaymentIcon({ method, size = 19 }) { const Icon = method === 'cash' ? Banknote : method === 'momo' ? Smartphone : CreditCard; return <Icon size={size} strokeWidth={1.7} />; }
export function MethodBadge({ method }) { return method ? <span className="method-label"><PaymentIcon method={method} size={15} />{methodLabel[method]}</span> : <span className="muted">Not recorded</span>; }
export function StatusBadge({ status }) { return <Badge dot tone={status === 'paid' ? 'green' : status === 'needs_reconciliation' || status === 'failed' ? 'red' : status === 'cancelled' || status === 'refunded' ? 'neutral' : status === 'partially_refunded' ? 'amber' : 'amber'}>{statusLabel[status] || status}</Badge>; }
export function Modal({ title, subtitle, children, onClose, wide = false, busy = false, className = '' }) {
  const titleId = useId();
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => (ref.current?.querySelector('input:not([type="checkbox"]), select, textarea') || ref.current?.querySelector('button'))?.focus(), 30);
    const key = e => {
      if (e.key === 'Escape' && !busyRef.current) closeRef.current();
      if (e.key === 'Tab') {
        const elements = [...(ref.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || [])].filter(el => el.offsetParent !== null);
        const first = elements[0], last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section ref={ref} className={`modal ${wide ? 'modal-wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton icon={X} label="Close dialog" onClick={onClose} disabled={busy} /></div>{children}</section></div>;
}
export function Notice({ children, tone = 'info', icon: Icon = AlertCircle }) { return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : undefined}><Icon size={18} /><div>{children}</div></div>; }
export function PageHeading({ eyebrow, title, description, children }) { return <div className="page-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1 tabIndex={-1}>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="heading-actions">{children}</div>}</div>; }
export function Stat({ label, value, detail, tone = '' }) { return <div className={`stat-card ${tone}`}><div className="stat-top">{label}</div><strong>{value}</strong>{detail && <p>{detail}</p>}</div>; }
export function Toast({ toast, onClose }) { useEffect(() => { if (!toast) return; const t = setTimeout(onClose, 5000); return () => clearTimeout(t); }, [toast, onClose]); return toast ? <div className={`toast ${toast.tone || 'success'}`} role={toast.tone === 'error' ? 'alert' : 'status'}>{toast.tone === 'error' ? <AlertCircle size={20} /> : <Check size={20} />}<span>{toast.message}</span><button aria-label="Dismiss notification" onClick={onClose}><X size={16} /></button></div> : null; }
export function NoResults({ clear }) { return <Empty icon={SearchX} title="No matching products" action={<button className="button secondary" onClick={clear}>Clear filters</button>}>Try another name, SKU, or category.</Empty>; }
export function Money({ value }) { return <span className="tabular">{money(value)}</span>; }
// On intermediate screens a table can still scroll. Keep that region named and keyboard reachable;
// at phone sizes the same semantic table reflows into readable records in CSS.
export function TableRegion({ label, children }) { return <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>{children}</div>; }
