let config = { providers: [], records: [] };
let currentProvider = null;
let currentRecord = null;

// Dark mode
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

// Load and render IP history
async function loadIPHistory() {
    const container = document.getElementById('ipHistoryContainer');
    try {
        const response = await fetch('/api/ip-history');
        const data = await response.json();
        if (!data.success || data.history.length === 0) {
            container.innerHTML = '<p class="history-empty">No IP changes recorded yet.</p>';
            return;
        }
        container.innerHTML = `
            <table class="history-table">
                <thead>
                    <tr><th>Date &amp; Time</th><th>Previous IP</th><th>New IP</th></tr>
                </thead>
                <tbody>
                    ${data.history.map(entry => {
                        const d = new Date(entry.timestamp);
                        const formatted = d.toLocaleString(undefined, {
                            year: 'numeric', month: 'short', day: '2-digit',
                            hour: '2-digit', minute: '2-digit', second: '2-digit'
                        });
                        return `<tr>
                            <td class="history-ts">${formatted}</td>
                            <td class="history-ip history-ip-old">${entry.oldIp || '<span class="history-none">—</span>'}</td>
                            <td class="history-ip history-ip-new">${entry.newIp}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>`;
    } catch (error) {
        container.innerHTML = '<p class="history-empty">Error loading IP history.</p>';
    }
}

// Load and render logs
// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();
    loadConfig();
    loadStatus();
    loadIPHistory();
    setInterval(loadStatus, 30000);
});

// Load configuration from server
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        config = await response.json();
        
        document.getElementById('checkInterval').value = config.checkInterval || '*/5 * * * *';
        
        renderProviders();
        renderRecords();
    } catch (error) {
        showNotification('Error loading configuration', 'error');
    }
}

// Load IP status
async function loadStatus() {
    try {
        const response = await fetch('/api/status');
        const status = await response.json();
        
        document.getElementById('currentIP').textContent = status.currentIP || 'Unknown';
        document.getElementById('lastIP').textContent = status.lastIP || 'Not set';
        
        const statusEl = document.getElementById('ipStatus');
        if (status.changed) {
            statusEl.textContent = 'Changed';
            statusEl.style.color = '#dc3545';
        } else {
            statusEl.textContent = 'Unchanged';
            statusEl.style.color = '#28a745';
        }
    } catch (error) {
        console.error('Error loading status:', error);
    }
}

// Render providers list
function renderProviders() {
    const container = document.getElementById('providersList');
    
    if (config.providers.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No providers configured</p><p>Add a DNS provider to get started</p></div>';
        return;
    }
    
    container.innerHTML = config.providers.map(provider => `
        <div class="card">
            <h3>${provider.name}</h3>
            <div class="card-content">
                <div><span class="badge badge-${provider.type}">${provider.type.toUpperCase()}</span></div>
                <div><strong>Zone:</strong> ${provider.zoneName}</div>
                ${provider.type === 'azure' ? `<div><strong>Resource Group:</strong> ${provider.resourceGroup}</div>` : ''}
                ${provider.type === 'cloudflare' && provider.zoneId ? `<div><strong>Zone ID:</strong> <code style="font-size:0.8em;">${provider.zoneId}</code></div>` : ''}
            </div>
            <div class="card-actions">
                <button class="btn btn-primary btn-small" onclick='editProvider(${JSON.stringify(provider)})'>Edit</button>
                <button class="btn btn-scan btn-small" onclick="scanZone('${provider.id}')">Scan Zone</button>
                <button class="btn btn-danger btn-small" onclick="deleteProvider('${provider.id}')">Delete</button>
            </div>
        </div>
    `).join('');
}

// Render records list
function renderRecords() {
    const container = document.getElementById('recordsList');

    if (config.records.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No DNS records configured</p><p>Add a DNS record to start tracking</p></div>';
        return;
    }

    // Group records by provider, sorted by provider zone name then record name
    const groups = {};
    for (const record of config.records) {
        const pid = record.providerId;
        if (!groups[pid]) groups[pid] = [];
        groups[pid].push(record);
    }
    // Sort records within each group alphabetically
    for (const pid of Object.keys(groups)) {
        groups[pid].sort((a, b) => a.name.localeCompare(b.name));
    }
    // Sort groups by zone name
    const sortedProviderIds = Object.keys(groups).sort((a, b) => {
        const pa = config.providers.find(p => p.id === a);
        const pb = config.providers.find(p => p.id === b);
        return (pa?.zoneName || '').localeCompare(pb?.zoneName || '');
    });

    container.innerHTML = sortedProviderIds.map(pid => {
        const provider = config.providers.find(p => p.id === pid);
        const records = groups[pid];
        const providerLabel = provider
            ? `<span class="badge badge-${provider.type}" style="font-size:0.8em;vertical-align:middle;">${provider.type.toUpperCase()}</span> &nbsp;${provider.name} &mdash; <span class="zone-label">${provider.zoneName}</span>`
            : `<span class="zone-label">Unknown provider</span>`;

        const rows = records.map(record => `
            <tr class="record-row ${record.enabled ? '' : 'record-disabled'}">
                <td class="record-name">${record.name}<span class="record-zone-suffix">.${provider ? provider.zoneName : ''}</span></td>
                <td><span class="badge badge-${record.enabled ? 'enabled' : 'disabled'}">${record.enabled ? 'Enabled' : 'Disabled'}</span></td>
                <td class="record-meta">TTL ${record.ttl || 3600}s</td>
                ${provider?.type === 'cloudflare' ? `<td class="record-meta">${record.proxied ? '🟠 Proxied' : '⚫ DNS only'}</td>` : '<td></td>'}
                <td class="record-actions-cell">
                    <button class="btn btn-primary btn-small" onclick='editRecord(${JSON.stringify(record)})'>Edit</button>
                    <button class="btn btn-danger btn-small" onclick="deleteRecord('${record.id}')">Delete</button>
                </td>
            </tr>
        `).join('');

        return `
            <div class="record-group">
                <div class="record-group-header">${providerLabel}</div>
                <table class="record-table">
                    <thead>
                        <tr>
                            <th>Record</th>
                            <th>Status</th>
                            <th>TTL</th>
                            <th>${provider?.type === 'cloudflare' ? 'Proxy' : ''}</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }).join('');
}

// Provider Modal Functions
function showProviderModal() {
    currentProvider = null;
    document.getElementById('providerModalTitle').textContent = 'Add Provider';
    document.getElementById('providerName').value = '';
    document.getElementById('providerType').value = 'azure';
    document.getElementById('zoneName').value = '';
    document.getElementById('subscriptionId').value = '';
    document.getElementById('tenantId').value = '';
    document.getElementById('clientId').value = '';
    document.getElementById('clientSecret').value = '';
    document.getElementById('resourceGroup').value = '';
    document.getElementById('cfZoneId').value = '';
    document.getElementById('apiToken').value = '';
    updateProviderFields();
    document.getElementById('providerModal').style.display = 'block';
}

function editProvider(provider) {
    currentProvider = provider;
    document.getElementById('providerModalTitle').textContent = 'Edit Provider';
    document.getElementById('providerName').value = provider.name;
    document.getElementById('providerType').value = provider.type;
    document.getElementById('zoneName').value = provider.zoneName;
    
    if (provider.type === 'azure') {
        document.getElementById('subscriptionId').value = provider.subscriptionId || '';
        document.getElementById('tenantId').value = provider.tenantId || '';
        document.getElementById('clientId').value = provider.clientId || '';
        document.getElementById('clientSecret').value = provider.clientSecret || '';
        document.getElementById('resourceGroup').value = provider.resourceGroup || '';
    } else {
        document.getElementById('cfZoneId').value = provider.zoneId || '';
        document.getElementById('apiToken').value = provider.apiToken || '';
    }
    
    updateProviderFields();
    document.getElementById('providerModal').style.display = 'block';
}

function closeProviderModal() {
    document.getElementById('providerModal').style.display = 'none';
}

function updateProviderFields() {
    const type = document.getElementById('providerType').value;
    document.getElementById('azureFields').style.display = type === 'azure' ? 'block' : 'none';
    document.getElementById('cloudflareFields').style.display = type === 'cloudflare' ? 'block' : 'none';
}

async function saveProvider() {
    const provider = {
        id: currentProvider?.id,
        name: document.getElementById('providerName').value,
        type: document.getElementById('providerType').value,
        zoneName: document.getElementById('zoneName').value
    };
    
    if (provider.type === 'azure') {
        provider.subscriptionId = document.getElementById('subscriptionId').value;
        provider.tenantId = document.getElementById('tenantId').value;
        provider.clientId = document.getElementById('clientId').value;
        provider.clientSecret = document.getElementById('clientSecret').value;
        provider.resourceGroup = document.getElementById('resourceGroup').value;
    } else {
        provider.zoneId = document.getElementById('cfZoneId').value;
        provider.apiToken = document.getElementById('apiToken').value;
    }
    
    try {
        const response = await fetch('/api/providers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(provider)
        });
        
        if (response.ok) {
            showNotification('Provider saved successfully', 'success');
            closeProviderModal();
            await loadConfig();
        } else {
            showNotification('Error saving provider', 'error');
        }
    } catch (error) {
        showNotification('Error saving provider', 'error');
    }
}

async function deleteProvider(id) {
    if (!confirm('Are you sure you want to delete this provider? All associated records will also be deleted.')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/providers/${id}`, { method: 'DELETE' });
        if (response.ok) {
            showNotification('Provider deleted', 'success');
            await loadConfig();
        } else {
            showNotification('Error deleting provider', 'error');
        }
    } catch (error) {
        showNotification('Error deleting provider', 'error');
    }
}

// Record Modal Functions
function showRecordModal() {
    currentRecord = null;
    document.getElementById('recordModalTitle').textContent = 'Add DNS Record';
    document.getElementById('recordName').value = '';
    document.getElementById('recordTTL').value = '3600';
    document.getElementById('recordProxied').checked = false;
    document.getElementById('recordEnabled').checked = true;
    
    updateRecordProviderList();
    document.getElementById('recordModal').style.display = 'block';
}

function editRecord(record) {
    currentRecord = record;
    document.getElementById('recordModalTitle').textContent = 'Edit DNS Record';
    document.getElementById('recordProvider').value = record.providerId;
    document.getElementById('recordName').value = record.name;
    document.getElementById('recordTTL').value = record.ttl || 3600;
    document.getElementById('recordProxied').checked = record.proxied || false;
    document.getElementById('recordEnabled').checked = record.enabled !== false;
    
    updateRecordProviderList();
    updateProxiedField();
    document.getElementById('recordModal').style.display = 'block';
}

function closeRecordModal() {
    document.getElementById('recordModal').style.display = 'none';
}

function updateRecordProviderList() {
    const select = document.getElementById('recordProvider');
    select.innerHTML = config.providers.map(p => 
        `<option value="${p.id}">${p.name} (${p.zoneName})</option>`
    ).join('');
    
    if (currentRecord) {
        select.value = currentRecord.providerId;
    }
    
    select.addEventListener('change', updateProxiedField);
    updateProxiedField();
}

function updateProxiedField() {
    const providerId = document.getElementById('recordProvider').value;
    const provider = config.providers.find(p => p.id === providerId);
    document.getElementById('proxiedField').style.display = 
        provider?.type === 'cloudflare' ? 'block' : 'none';
}

async function saveRecord() {
    const record = {
        id: currentRecord?.id,
        providerId: document.getElementById('recordProvider').value,
        name: document.getElementById('recordName').value,
        ttl: parseInt(document.getElementById('recordTTL').value),
        enabled: document.getElementById('recordEnabled').checked
    };
    
    const provider = config.providers.find(p => p.id === record.providerId);
    if (provider?.type === 'cloudflare') {
        record.proxied = document.getElementById('recordProxied').checked;
    }
    
    try {
        const response = await fetch('/api/records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        });

        if (response.ok) {
            const data = await response.json();
            closeRecordModal();
            await loadConfig();
            if (data.syncResult) {
                if (data.syncResult.success) {
                    showNotification('Record saved and written to DNS provider', 'success');
                } else {
                    showNotification(`Record saved, but DNS sync failed: ${data.syncResult.error}`, 'error');
                }
            } else {
                showNotification('Record saved successfully', 'success');
            }
        } else {
            showNotification('Error saving record', 'error');
        }
    } catch (error) {
        showNotification('Error saving record', 'error');
    }
}

let pendingDeleteRecordId = null;

function deleteRecord(id) {
    const record = config.records.find(r => r.id === id);
    const provider = config.providers.find(p => p.id === record?.providerId);
    const label = record
        ? `${record.name}.${provider ? provider.zoneName : '?'}`
        : id;

    pendingDeleteRecordId = id;
    document.getElementById('deleteRecordLabel').textContent = label;

    // Reset to default: delete from both
    document.querySelector('input[name="deleteScope"][value="provider"]').checked = true;
    updateDeleteConfirmButton();

    // Update button label live when selection changes
    document.querySelectorAll('input[name="deleteScope"]').forEach(radio => {
        radio.onchange = updateDeleteConfirmButton;
    });

    document.getElementById('deleteRecordModal').style.display = 'block';
}

function updateDeleteConfirmButton() {
    const scope = document.querySelector('input[name="deleteScope"]:checked')?.value;
    const btn = document.getElementById('confirmDeleteBtn');
    btn.textContent = scope === 'provider'
        ? 'Delete from tracker and DNS provider'
        : 'Remove from tracker only';
}

function closeDeleteRecordModal() {
    document.getElementById('deleteRecordModal').style.display = 'none';
    pendingDeleteRecordId = null;
}

async function confirmDeleteRecord() {
    const scope = document.querySelector('input[name="deleteScope"]:checked')?.value;
    const deleteFromProvider = scope === 'provider';
    const id = pendingDeleteRecordId;
    closeDeleteRecordModal();

    try {
        const url = `/api/records/${id}${deleteFromProvider ? '?deleteFromProvider=true' : ''}`;
        const response = await fetch(url, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            showNotification(
                deleteFromProvider ? 'Record deleted from tracker and DNS provider' : 'Record removed from tracker',
                'success'
            );
            await loadConfig();
        } else {
            showNotification('Error: ' + (data.error || 'Delete failed'), 'error');
        }
    } catch (error) {
        showNotification('Error deleting record', 'error');
    }
}

// Manual update
async function manualUpdate() {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = 'Updating...';
    
    try {
        const response = await fetch('/api/update', { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
            showNotification(`DNS updated! IP: ${result.ip}`, 'success');
            await loadStatus();
        } else {
            showNotification(result.message || 'Update failed', 'error');
        }
    } catch (error) {
        showNotification('Error updating DNS', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Update Now';
    }
}

// Update interval
async function updateInterval() {
    const interval = document.getElementById('checkInterval').value;
    
    try {
        const response = await fetch('/api/interval', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interval })
        });
        
        if (response.ok) {
            showNotification('Check interval updated', 'success');
        } else {
            showNotification('Error updating interval', 'error');
        }
    } catch (error) {
        showNotification('Error updating interval', 'error');
    }
}

// Show notification
function showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = `notification ${type}`;
    
    setTimeout(() => {
        notification.classList.add('show');
    }, 100);
    
    setTimeout(() => {
        notification.classList.remove('show');
    }, 3000);
}

// Close modals on outside click
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
}

// ── Zone Scanner ─────────────────────────────────────────────────────────────

let scanProviderId = null;
let scannedRecords = [];

async function scanZone(providerId) {
    scanProviderId = providerId;
    scannedRecords = [];

    const provider = config.providers.find(p => p.id === providerId);
    document.getElementById('scanModalTitle').textContent =
        `Scan Zone: ${provider ? provider.zoneName : ''}`;

    document.getElementById('scanLoading').style.display = 'block';
    document.getElementById('scanResults').style.display = 'none';
    document.getElementById('scanError').style.display = 'none';
    document.getElementById('importBtn').style.display = 'none';
    document.getElementById('scanModal').style.display = 'block';

    try {
        const response = await fetch(`/api/providers/${providerId}/scan`);
        const data = await response.json();

        document.getElementById('scanLoading').style.display = 'none';

        if (!data.success) {
            document.getElementById('scanError').textContent = data.error || 'Scan failed';
            document.getElementById('scanError').style.display = 'block';
            return;
        }

        scannedRecords = data.records;
        renderScanResults(provider, data.records);
        document.getElementById('scanResults').style.display = 'block';
        document.getElementById('importBtn').style.display = 'inline-block';
    } catch (error) {
        document.getElementById('scanLoading').style.display = 'none';
        document.getElementById('scanError').textContent = 'Error scanning zone: ' + error.message;
        document.getElementById('scanError').style.display = 'block';
    }
}

function renderScanResults(provider, records) {
    const list = document.getElementById('scanRecordsList');

    if (records.length === 0) {
        list.innerHTML = '<p class="scan-empty">No A records found in this zone.</p>';
        return;
    }

    list.innerHTML = records.map((r, i) => `
        <div class="scan-record ${r.alreadyTracked ? 'scan-record-tracked' : ''}">
            <label class="scan-record-label">
                <input type="checkbox" class="scan-checkbox" data-index="${i}"
                    ${r.alreadyTracked ? 'disabled checked' : 'checked'}
                />
                <span class="scan-record-name">${r.name}<span class="scan-zone-suffix">.${provider.zoneName}</span></span>
                <span class="scan-record-ip">${r.currentIp || '—'}</span>
                <span class="scan-record-ttl">TTL ${r.ttl || 3600}s</span>
                ${r.proxied !== undefined ? `<span class="badge badge-cloudflare" style="font-size:0.75em;">${r.proxied ? 'proxied' : 'dns-only'}</span>` : ''}
                ${r.alreadyTracked ? '<span class="badge badge-enabled" style="font-size:0.75em;">tracked</span>' : ''}
            </label>
        </div>
    `).join('');
}

function selectAllScanRecords(checked) {
    document.querySelectorAll('.scan-checkbox:not([disabled])').forEach(cb => {
        cb.checked = checked;
    });
}

async function importScannedRecords() {
    const checkboxes = document.querySelectorAll('.scan-checkbox:not([disabled])');
    const toImport = [];
    checkboxes.forEach(cb => {
        if (cb.checked) {
            toImport.push(scannedRecords[parseInt(cb.dataset.index)]);
        }
    });

    if (toImport.length === 0) {
        showNotification('No records selected', 'info');
        return;
    }

    const provider = config.providers.find(p => p.id === scanProviderId);
    let imported = 0;
    let failed = 0;

    for (const r of toImport) {
        const record = {
            providerId: scanProviderId,
            name: r.name,
            ttl: r.ttl || 3600,
            enabled: true
        };
        if (provider?.type === 'cloudflare') {
            record.proxied = r.proxied || false;
        }

        try {
            const response = await fetch('/api/records', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(record)
            });
            if (response.ok) imported++;
            else failed++;
        } catch (_) {
            failed++;
        }
    }

    closeScanModal();
    await loadConfig();

    if (failed === 0) {
        showNotification(`Imported ${imported} record${imported !== 1 ? 's' : ''}`, 'success');
    } else {
        showNotification(`Imported ${imported}, failed ${failed}`, 'error');
    }
}

function closeScanModal() {
    document.getElementById('scanModal').style.display = 'none';
}

