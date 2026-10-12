import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownLink } from './markdown.jsx';
import './sponsorship.css';

function SponsorshipDialog({ id, trigger, onClose, Icon }) {
  const dialog = useRef(null);

  useEffect(() => {
    const element = dialog.current;
    const origin = trigger.current;
    element.showModal();
    return () => {
      element.close();
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
  }, [trigger]);

  function handleKeyDown(event) {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && ['k', ','].includes(event.key.toLowerCase())) event.preventDefault();
  }

  return createPortal(<dialog id={id} ref={dialog} className="sponsorship-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onKeyDown={handleKeyDown} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="sponsorship-heading">
      <h2 id={`${id}-title`}>支持项目</h2>
      <button type="button" className="icon-button sponsorship-close" aria-label="关闭支持项目" onClick={onClose} autoFocus><Icon name="close" size={15} /></button>
    </header>
    <div className="sponsorship-body" role="region" aria-label="爱发电支持方式" tabIndex={0}>
      <p id={`${id}-description`}>自愿支持，用于项目开发与维护。</p>
      <p className="sponsorship-thanks">由 Qn 开发与维护，感谢你使用青禾 Studio。</p>
      <p className="sponsorship-links"><MarkdownLink href="https://afdian.com/a/qnqinghe" title="Qn 的爱发电主页">前往爱发电主页 <Icon name="link" size={16} /></MarkdownLink></p>
      <p className="sponsorship-thanks">金额由你决定，是否赞助不影响现有功能。</p>
    </div>
  </dialog>, document.body);
}

export default function SponsorshipButton({ Icon }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const id = useId();

  return <>
    <button type="button" className="sidebar-settings" ref={trigger} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}><Icon name="heart" size={17} /><span>支持项目</span></button>
    {open && <SponsorshipDialog id={id} trigger={trigger} onClose={() => setOpen(false)} Icon={Icon} />}
  </>;
}
