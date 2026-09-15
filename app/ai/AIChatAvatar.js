import React, { useState } from 'react';

export default function AIChatAvatar({ role = 'assistant', user }) {
    const [failedPhoto, setFailedPhoto] = useState(null);
    if (role === 'assistant') return <span className="ai-chat-avatar ai-chat-avatar--assistant">
        <img src="icons/icon48.png" alt="Tabox AI" />
    </span>;
    const photo = /^https:\/\//i.test(user?.photoLink || '') ? user.photoLink : null;
    const initials = (user?.displayName || user?.emailAddress || 'You').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'Y';
    return <span className="ai-chat-avatar ai-chat-avatar--user">
        {photo && failedPhoto !== photo
            ? <img src={photo} alt="You" referrerPolicy="no-referrer" onError={() => setFailedPhoto(photo)} />
            : <span role="img" aria-label="You">{initials}</span>}
    </span>;
}
