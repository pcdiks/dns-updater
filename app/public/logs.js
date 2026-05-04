// Shared dark mode (mirrors app.js so preference persists across pages)
function initDarkMode() {
    if (localStorage.getItem('darkMode') === 'true') {
        document.body.classList.add('dark');
        document.getElementById('darkModeToggle').textContent = '☀️';
    }
}

function toggleDarkMode() {
    const isDark = document.body.classList.toggle('dark');
    localStorage.setItem('darkMode', isDark);
    document.getElementById('darkModeToggle').textContent = isDark ? '☀️' : '🌙';
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Highlight the search term inside a message string
function highlight(str, term) {
    if (!term) return escapeHtml(str);
    const escaped = escapeHtml(str);
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
}

// Raw log data from last fetch
let allLogs = [];
let autoRefreshTimer = null;

async function loadLogs() {
    const limit = document.getElementById('logLimit').value;
    try {
        const response = await fetch(`/api/logs?limit=${limit}`);
        const data = await response.json();
        allLogs = data.success ? data.logs : [];
    } catch (_) {
        allLogs = [];
    }
    applyFilter();
}

function applyFilter() {
    const container = document.getElementById('logsContainer');
    const term = document.getElementById('logSearch').value.trim().toLowerCase();
    const showInfo  = document.getElementById('filterInfo').checked;
    const showWarn  = document.getElementById('filterWarn').checked;
    const showError = document.getElementById('filterError').checked;

    const filtered = allLogs.filter(entry => {
        if (entry.level === 'info'  && !showInfo)  return false;
        if (entry.level === 'warn'  && !showWarn)  return false;
        if (entry.level === 'error' && !showError) return false;
        if (term && !entry.message.toLowerCase().includes(term)) return false;
        return true;
    });

    // Stats bar
    const total = allLogs.length;
    const shown = filtered.length;
    const errors = allLogs.filter(e => e.level === 'error').length;
    const warns  = allLogs.filter(e => e.level === 'warn').length;
    document.getElementById('logsStats').innerHTML =
        `Showing <strong>${shown}</strong> of <strong>${total}</strong> entries` +
        (errors ? ` &nbsp;·&nbsp; <span style="color:#f85149">${errors} error${errors !== 1 ? 's' : ''}</span>` : '') +
        (warns  ? ` &nbsp;·&nbsp; <span style="color:#e3b341">${warns} warning${warns  !== 1 ? 's' : ''}</span>` : '');

    if (filtered.length === 0) {
        container.innerHTML = `<span class="log-empty">${total === 0 ? 'No log entries yet.' : 'No entries match the current filter.'}</span>`;
        return;
    }

    container.innerHTML = filtered.map(entry => {
        const d = new Date(entry.ts);
        const ts = d.toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        // Extract [tag] prefix for a separate styled span
        const tagMatch = entry.message.match(/^\[([^\]]+)\]\s*/);
        let tag = '';
        let msg = entry.message;
        if (tagMatch) {
            tag = tagMatch[1];
            msg = entry.message.slice(tagMatch[0].length);
        }
        const tagHtml = tag
            ? `<span class="log-tag log-tag-${tag}">${tag}</span>`
            : '';
        return `<div class="log-line log-${entry.level}">` +
               `<span class="log-ts">${ts}</span>` +
               `<span class="log-level log-level-${entry.level}">${entry.level.toUpperCase()}</span>` +
               tagHtml +
               `<span class="log-msg">${highlight(msg, term)}</span>` +
               `</div>`;
    }).join('');
}

function clearSearch() {
    document.getElementById('logSearch').value = '';
    applyFilter();
}

function toggleAutoRefresh() {
    const enabled = document.getElementById('autoRefresh').checked;
    if (enabled) {
        autoRefreshTimer = setInterval(loadLogs, 15000);
    } else {
        clearInterval(autoRefreshTimer);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();
    loadLogs();
    autoRefreshTimer = setInterval(loadLogs, 15000);
});
