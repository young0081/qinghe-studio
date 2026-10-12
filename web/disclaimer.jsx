import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import './disclaimer.css';

const sections = [
  { title: '合法与授权使用', text: '青禾 Studio 是通用 AI 编程与自动化工具，仅用于合法且获授权的学习、开发及办公。禁止用于诈骗、非法入侵、传播违法内容、侵犯他人隐私或知识产权，以及其他违法用途。' },
  { title: '使用者责任', text: '请确保对涉及的账号、数据、文件和系统拥有合法权利或相应授权，并依法对自己的输入、操作和传播行为负责。' },
  { title: 'AI 与自动操作风险', text: 'AI 输出可能有误；自动操作可能修改或删除文件，或操作外部服务。执行前请核验内容、妥善备份，并谨慎授予权限。' },
  { title: '第三方服务与数据', text: '使用第三方模型或服务时，请遵守其规则，自行确认数据处理方式及 API 费用。仅处理有权提交的数据，妥善保护密钥与隐私。' },
  { title: '责任范围', text: '开发者不授权或认可任何违法用途。在法律允许的范围内，开发者不对滥用或未经核验使用所产生的损失承担责任。本声明不排除或限制依法不得排除或限制的责任，也不承诺防止所有滥用。' },
];

export default function DisclaimerDialog({ trigger, onClose, Icon }) {
  const dialog = useRef(null);
  const id = useId();

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

  return createPortal(<dialog ref={dialog} className="disclaimer-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onKeyDown={handleKeyDown} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="disclaimer-heading">
      <div><span>青禾 Studio</span><h2 id={`${id}-title`}>使用声明与免责声明</h2></div>
      <button type="button" className="icon-button disclaimer-close" aria-label="关闭使用声明" onClick={onClose} autoFocus><Icon name="close" size={15} /></button>
    </header>
    <div className="disclaimer-body" role="region" aria-label="使用声明正文" tabIndex={0}>
      <p id={`${id}-description`} className="disclaimer-intro">合法使用，谨慎执行。使用前请了解以下适用范围、风险与责任。</p>
      <ol className="disclaimer-sections">{sections.map(section => <li key={section.title}><h3>{section.title}</h3><p>{section.text}</p></li>)}</ol>
    </div>
  </dialog>, document.body);
}
