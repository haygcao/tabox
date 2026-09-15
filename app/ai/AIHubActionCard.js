import React, { useState } from 'react';
import { MdCheck, MdUndo, MdExpandMore } from 'react-icons/md';

// One decision at a time. Existing editors remain available on demand.
export default function AIHubActionCard({ title, description, primary, done, children }) {
    const [expanded, setExpanded] = useState(false);
    return <div className={`ai-hub-proposal${done ? ' ai-hub-proposal--done' : ''}`}>
        <div className="ai-hub-proposal-heading">
            {done && <span className="ai-hub-result-icon" aria-hidden="true"><MdCheck size={19} /></span>}
            <p className="ai-hub-proposal-title">{title}</p>
        </div>
        {description && <p className="ai-hub-proposal-description">{description}</p>}
        <div className="ai-hub-proposal-actions">
            {primary && !expanded && <button type="button" className={done ? 'ai-hub-result-undo' : 'ai-tool-action-btn'}
                disabled={primary.disabled} onClick={primary.onClick}>{done && <MdUndo size={15} aria-hidden="true" />}{primary.label}</button>}
            {children && <button type="button" className="tp-new-plan-btn ai-hub-details-toggle" aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide details' : 'View details'}<MdExpandMore size={17} aria-hidden="true" /></button>}
        </div>
        <div className="ai-hub-proposal-details" hidden={!expanded}>{children}</div>
    </div>;
}
