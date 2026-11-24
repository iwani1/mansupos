import React, { useEffect, useState } from 'react';
import { MessageSquareText, Send, CheckCircle2, Clock } from 'lucide-react';
import { api, dateTime } from './api.js';
import { PageHeading, Notice, Spinner } from './components.jsx';

// Platform shops only: tell Mansu POS about a problem, an idea or a question.
// Replies from the Mansu POS team show here. Cashiers see their own messages;
// owners and managers see the whole shop's.
const KINDS = [['problem', 'Something is wrong'], ['idea', 'An idea'], ['question', 'A question']];

export default function Feedback({ notify, fromPage = '' }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('problem');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api('/feedback').then(r => setList(r.feedback)).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  const send = async event => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/feedback', { method: 'POST', body: { kind, message, page: fromPage } });
      setMessage(''); notify?.('Sent. Thank you — we reply here, usually within a working day.');
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <div className="setup-page">
    <PageHeading eyebrow="Help us improve" title="Feedback" description="Tell the Mansu POS team what went wrong, what you need, or ask a question. We read every message." />
    {error && <Notice tone="error">{error}</Notice>}
    <form className="surface setup-step" onSubmit={send}>
      <div className="setup-step-head"><MessageSquareText size={18} aria-hidden="true" /><h2>New message</h2></div>
      <div className="setup-step-body">
        <div className="billing-intervals" role="radiogroup" aria-label="Kind of message">
          {KINDS.map(([key, text]) => <button key={key} type="button" role="radio" aria-checked={kind === key} className={kind === key ? 'selected' : ''} onClick={() => setKind(key)}>{text}</button>)}
        </div>
        <label className="feedback-field">Message
          <textarea className="input" rows={5} maxLength={2000} required minLength={5} value={message} onChange={e => setMessage(e.target.value)}
            placeholder={kind === 'problem' ? 'What happened, on which page, and what you expected. Include the receipt number if it is about a sale.' : ''} />
        </label>
        <p className="field-hint">Do not include passwords or card numbers.</p>
        <button type="submit" className="button primary" disabled={busy || message.trim().length < 5}><Send size={15} /> {busy ? 'Sending…' : 'Send'}</button>
      </div>
    </form>
    {!list ? <Spinner label="Loading messages…" /> : list.length > 0 && <section className="surface setup-step">
      <div className="setup-step-head"><CheckCircle2 size={18} aria-hidden="true" /><h2>Messages and replies</h2></div>
      <ul className="setup-health">{list.map(f => <li key={f.id} className={f.status === 'resolved' ? 'pass' : 'pending'}>
        {f.status === 'resolved' ? <CheckCircle2 size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
        <div><strong>{Object.fromEntries(KINDS)[f.kind] || f.kind} · {f.fromUser}</strong>
          <span className="feedback-text">{f.message}</span>
          <span>{dateTime(f.createdAt)} · {f.status === 'resolved' ? 'answered' : 'waiting for a reply'}</span>
          {f.status === 'resolved' && f.reply && <span className="feedback-reply">Mansu POS: {f.reply}</span>}
        </div></li>)}</ul>
    </section>}
  </div>;
}
