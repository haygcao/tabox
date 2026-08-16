import React from 'react';
import './TaskPlannerToolIcon.css';

// Animated icon for the "Task Planner" AI hero card.
// Static state: a chat bubble containing a plotted route (a line connecting
// waypoint dots) with a sparkle at the top corner — "chat that maps out a
// plan". On card hover it plays once: the route redraws left→right, the
// waypoints pop in along it, and the sparkle twinkles.
// CSS-only (transform/opacity/dashoffset, compositor-friendly); degrades to
// the static state under prefers-reduced-motion / performance mode.
// Decorative only.
function TaskPlannerToolIcon({ className = '' }) {
    return (
        <svg
            className={`tpi-svg ${className}`.trim()}
            width="52"
            height="44"
            viewBox="0 0 40 34"
            fill="none"
            aria-hidden="true"
        >
            {/* Chat bubble with a tail */}
            <path
                className="tpi-bubble"
                d="M 9 4 H 31 C 33.8 4 36 6.2 36 9 V 19 C 36 21.8 33.8 24 31 24 H 17 L 11 30 V 24 H 9 C 6.2 24 4 21.8 4 19 V 9 C 4 6.2 6.2 4 9 4 Z"
            />
            {/* The plotted route inside the bubble */}
            <polyline
                className="tpi-route"
                points="9.5,19 16,11.5 23,16.5 30.5,9.5"
                pathLength="100"
            />
            {/* Waypoint dots along the route */}
            <circle className="tpi-dot tpi-dot-1" cx="9.5" cy="19" r="2" />
            <circle className="tpi-dot tpi-dot-2" cx="16" cy="11.5" r="2" />
            <circle className="tpi-dot tpi-dot-3" cx="23" cy="16.5" r="2" />
            <circle className="tpi-dot tpi-dot-4" cx="30.5" cy="9.5" r="2" />
            {/* Sparkle at the bubble's top corner */}
            <path
                className="tpi-spark"
                d="M 35 0.4 L 36.1 3 L 38.7 4.1 L 36.1 5.2 L 35 7.8 L 33.9 5.2 L 31.3 4.1 L 33.9 3 Z"
            />
        </svg>
    );
}

export default TaskPlannerToolIcon;
